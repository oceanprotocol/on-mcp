import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
  Datatoken,
  Dispenser,
  FixedRateExchange,
  ProviderInstance
} from '@oceanprotocol/lib'
import { Contract, formatUnits, getAddress, parseUnits } from 'ethers'
import { z } from 'zod/v4'

import type { EvmProviderRegistry } from '../evm/evmProviderRegistry.js'
import { stringifyError, textContent } from '../utils/format.js'
import {
  commandResultPayload,
  getProviderOrThrow,
  getVoidSigner,
  normalizeTxRequest,
  unsignedTxInputSchema
} from './evmToolUtils.js'

type Params = {
  server: McpServer
  evmRegistry: EvmProviderRegistry
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

const assetLikeSchema = z.object({
  id: z.string().describe('Asset DID'),
  chainId: z.number().int().positive(),
  services: z
    .array(
      z.object({
        id: z.string(),
        datatokenAddress: z.string()
      })
    )
    .min(1),
  datatokens: z
    .array(
      z.object({
        address: z.string()
      })
    )
    .min(1)
})

const providerFeesSchema = z
  .object({
    providerFeeAddress: z.string(),
    providerFeeToken: z.string(),
    providerFeeAmount: z.string(),
    v: z.number().optional(),
    r: z.string().optional(),
    s: z.string().optional(),
    validUntil: z.number().optional(),
    providerData: z.string().optional()
  })
  .passthrough()

const consumeMarketFeeSchema = z
  .object({
    consumeMarketFeeAddress: z.string(),
    consumeMarketFeeToken: z.string(),
    consumeMarketFeeAmount: z.string()
  })
  .passthrough()

const orderAssetStateSchema = z
  .object({
    index: z.number().int().nonnegative().default(0),
    txHashes: z.array(z.string()).default([])
  })
  .optional()

function getDatatoken(evmRegistry: EvmProviderRegistry, chainId: number, from: string) {
  const signer = getVoidSigner(evmRegistry, chainId, from) as any
  return new Datatoken(signer, chainId)
}

function getDispenser(
  evmRegistry: EvmProviderRegistry,
  chainId: number,
  from: string,
  dispenserAddress: string
) {
  const signer = getVoidSigner(evmRegistry, chainId, from) as any
  return new Dispenser(getAddress(dispenserAddress), signer, chainId)
}

function getFixedRateExchange(
  evmRegistry: EvmProviderRegistry,
  chainId: number,
  from: string,
  fixedRateExchangeAddress: string
) {
  const signer = getVoidSigner(evmRegistry, chainId, from) as any
  return new FixedRateExchange(getAddress(fixedRateExchangeAddress), signer, chainId)
}

async function buildErc20ApproveTx(params: {
  evmRegistry: EvmProviderRegistry
  chainId: number
  from: string
  token: string
  spender: string
  amountUnits: bigint
}) {
  const signer = getVoidSigner(params.evmRegistry, params.chainId, params.from) as any
  // Minimal ERC20 ABI for approve
  const abi = ['function approve(address spender, uint256 amount) returns (bool)']
  const erc20 = new Contract(getAddress(params.token), abi, signer)
  // Ensure provider is connected for populateTransaction and fee data resolution
  ;(erc20 as any).runner = signer
  const tx = await (erc20 as any).approve.populateTransaction(
    getAddress(params.spender),
    params.amountUnits
  )
  // Set from explicitly for signing clients
  return { ...tx, from: getAddress(params.from), chainId: params.chainId }
}

export function registerAssetTools({ server, evmRegistry }: Params): void {
  server.registerTool(
    'order_asset',
    {
      title: 'Order asset (unsigned tx plan)',
      description:
        'Builds a multi-step unsigned-transaction plan for ordering an asset, following the logic in ocean.js `orderAsset`.\n\nExecution model:\n- This tool NEVER signs or broadcasts.\n- For each step, sign the returned TransactionRequest offline.\n- Broadcast it via broadcast_transaction(chainId, txRaw).\n- Call order_asset again with `state` and `lastTxHash` to continue.\n\nNotes:\n- `asset` must include `id`, `chainId`, `services[]`, and `datatokens[]` fields.\n- If `providerFees` is omitted, the tool will attempt to fetch them via ProviderInstance (requires provider URL).',
      inputSchema: {
        chainId: z
          .number()
          .int()
          .positive()
          .describe('EVM chain id configured in EVM_CHAIN_RPCS.'),
        ...unsignedTxInputSchema,
        asset: assetLikeSchema.describe(
          'Minimal asset/DDO-like payload needed to order.'
        ),
        providerUrl: z
          .string()
          .optional()
          .describe('Provider URL for ProviderInstance.initialize (optional).'),
        oceanNodeUri: z
          .string()
          .optional()
          .describe('Fallback Provider URL if providerUrl is not provided.'),
        consumeMarketOrderFee: consumeMarketFeeSchema
          .optional()
          .describe('Optional consume market fee; defaults to zero fee.'),
        providerFees: providerFeesSchema
          .optional()
          .describe(
            'Optional provider fees; if omitted we try to fetch via ProviderInstance.'
          ),
        consumeMarketFixedSwapFee: z
          .string()
          .optional()
          .describe('Fixed swap fee for consuming the market (default "0").'),
        datatokenIndex: z.number().int().nonnegative().optional().default(0),
        serviceIndex: z.number().int().nonnegative().optional().default(0),
        fixedRateIndex: z.number().int().nonnegative().optional().default(0),
        state: orderAssetStateSchema.describe(
          'Continuation state returned by this tool.'
        ),
        lastTxHash: z
          .string()
          .optional()
          .describe(
            'Last broadcasted tx hash. If provided, the tool will confirm it before advancing.'
          )
      }
    },
    async ({
      chainId,
      from,
      asset,
      providerUrl,
      oceanNodeUri,
      consumeMarketOrderFee,
      providerFees,
      consumeMarketFixedSwapFee,
      datatokenIndex,
      serviceIndex,
      fixedRateIndex,
      state,
      lastTxHash
    }) => {
      try {
        const provider = getProviderOrThrow(evmRegistry, chainId)
        const assetParsed = assetLikeSchema.parse(asset)
        if (assetParsed.chainId !== chainId) {
          throw new Error(
            `Asset chainId (${assetParsed.chainId}) does not match requested chainId (${chainId}).`
          )
        }
        const consumeFee =
          consumeMarketOrderFee ||
          ({
            consumeMarketFeeAddress: ZERO_ADDRESS,
            consumeMarketFeeAmount: '0',
            consumeMarketFeeToken: ZERO_ADDRESS
          } as any)

        const dtAddress = getAddress(assetParsed.datatokens[datatokenIndex]?.address)
        const service = assetParsed.services[serviceIndex]
        if (!dtAddress) {
          throw new Error(`Invalid datatokenIndex=${datatokenIndex}`)
        }
        if (!service?.id) {
          throw new Error(`Invalid serviceIndex=${serviceIndex}`)
        }

        const datatoken = getDatatoken(evmRegistry, chainId, from)

        const templateIndex = await datatoken.getId(dtAddress)
        const fixedRates = await datatoken.getFixedRates(dtAddress)
        const dispensers = await datatoken.getDispensers(dtAddress)
        const publishMarketFees = await datatoken.getPublishingMarketFee(dtAddress)

        const pricingType =
          fixedRates.length > 0 ? 'fixed' : dispensers.length > 0 ? 'free' : 'NOT_ALLOWED'

        let fees = providerFees as any
        if (!fees) {
          const url = providerUrl || oceanNodeUri
          if (!url) {
            throw new Error(
              'providerFees not provided and no providerUrl/oceanNodeUri provided.'
            )
          }
          fees = (
            await ProviderInstance.initialize(
              assetParsed.id,
              service.id,
              0,
              getAddress(from),
              url
            )
          ).providerFee
        }

        const steps: Array<{
          id: string
          description: string
          tx: any
        }> = []

        // Step 0: provider fee approval if needed (approve providerFeeToken to datatoken)
        if (
          fees &&
          fees.providerFeeAddress !== ZERO_ADDRESS &&
          fees.providerFeeAmount &&
          parseInt(fees.providerFeeAmount) > 0
        ) {
          // providerFeeAmount is expected to be wei units string
          const approveTx = await buildErc20ApproveTx({
            evmRegistry,
            chainId,
            from,
            token: fees.providerFeeToken,
            spender: service.datatokenAddress,
            amountUnits: BigInt(fees.providerFeeAmount)
          })
          steps.push({
            id: 'approve_provider_fee',
            description:
              'Approve provider fee token for spending by datatoken (required when providerFees.providerFeeAmount > 0).',
            tx: approveTx
          })
        }

        const orderParams = {
          consumer: getAddress(from),
          serviceIndex,
          _providerFee: fees,
          _consumeMarketFee: consumeFee
        } as any

        if (pricingType === 'free') {
          if (templateIndex === 1) {
            const dispenser = getDispenser(
              evmRegistry,
              chainId,
              from,
              (asset as any).dispenserAddress ||
                (asset as any).config?.dispenserAddress ||
                (asset as any).dispenser ||
                ''
            )
            if (!dispenser || !(dispenser as any).dispenseTx) {
              throw new Error(
                'dispenserAddress is required for free/templateIndex=1 ordering.'
              )
            }
            const dispenserAddress =
              (asset as any).dispenserAddress || (asset as any).config?.dispenserAddress
            if (!dispenserAddress) {
              throw new Error(
                'dispenserAddress is required in asset payload for free ordering.'
              )
            }
            const dispenser2 = getDispenser(evmRegistry, chainId, from, dispenserAddress)
            const dispTx = await (dispenser2 as any).dispenseTx(
              dtAddress,
              '1',
              getAddress(from)
            )
            steps.push({
              id: 'dispense',
              description:
                'Dispense 1 datatoken from Dispenser (templateIndex=1 free pricing).',
              tx: { ...dispTx, from: getAddress(from), chainId }
            })
            const startOrderTx = await (datatoken as any).startOrderTx(
              dtAddress,
              orderParams.consumer,
              orderParams.serviceIndex,
              orderParams._providerFee,
              orderParams._consumeMarketFee
            )
            steps.push({
              id: 'start_order',
              description: 'Start order on datatoken (templateIndex=1).',
              tx: { ...startOrderTx, from: getAddress(from), chainId }
            })
          } else if (templateIndex === 2 || templateIndex === 4) {
            const buyTx = await (datatoken as any).buyFromDispenserAndOrderTx(
              service.datatokenAddress,
              orderParams,
              (asset as any).dispenserAddress || (asset as any).config?.dispenserAddress
            )
            steps.push({
              id: 'buy_from_dispenser_and_order',
              description:
                'Buy from Dispenser and start order in one tx (templateIndex=2/4).',
              tx: { ...buyTx, from: getAddress(from), chainId }
            })
          } else {
            throw new Error(
              `Unsupported datatoken templateIndex=${templateIndex} for free pricing.`
            )
          }
        } else if (pricingType === 'fixed') {
          const fre = getFixedRateExchange(
            evmRegistry,
            chainId,
            from,
            (asset as any).fixedRateExchangeAddress ||
              (asset as any).config?.fixedRateExchangeAddress
          )
          const frAddress =
            (asset as any).fixedRateExchangeAddress ||
            (asset as any).config?.fixedRateExchangeAddress
          if (!frAddress) {
            throw new Error(
              'fixedRateExchangeAddress is required in asset payload for fixed pricing.'
            )
          }
          if (!fixedRates[fixedRateIndex]?.id) {
            throw new Error(`No fixed rate exchange at fixedRateIndex=${fixedRateIndex}`)
          }
          const feesInfo = await (fre as any).getFeesInfo(fixedRates[fixedRateIndex].id)
          const exchange = await (fre as any).getExchange(fixedRates[fixedRateIndex].id)
          const calc = await (fre as any).calcBaseInGivenDatatokensOut(
            feesInfo.exchangeId,
            '1',
            consumeFee.consumeMarketFeeAmount
          )
          const baseDecimals = parseInt(exchange.btDecimals) || 18
          const baseAmountUnits = parseUnits(
            String(calc.baseTokenAmount || '0'),
            baseDecimals
          )
          const consumeFeeUnits = parseUnits(
            String(consumeFee.consumeMarketFeeAmount || '0'),
            baseDecimals
          )
          const publishFeeUnits = parseUnits(
            String(publishMarketFees.publishMarketFeeAmount || '0'),
            baseDecimals
          )
          const priceUnitsTotal = baseAmountUnits + consumeFeeUnits + publishFeeUnits
          const price = formatUnits(priceUnitsTotal, baseDecimals)

          const priceUnits = parseUnits(price, baseDecimals)

          const spenderForApprove = templateIndex === 1 ? frAddress : dtAddress
          const approveBaseTx = await buildErc20ApproveTx({
            evmRegistry,
            chainId,
            from,
            token: exchange.baseToken,
            spender: spenderForApprove,
            amountUnits: priceUnits
          })
          steps.push({
            id: 'approve_base_token',
            description: `Approve base token (${exchange.baseToken}) for fixed-rate purchase.`,
            tx: approveBaseTx
          })

          if (templateIndex === 1) {
            const buyTx = await (fre as any).buyDatatokensTx(
              exchange.exchangeId,
              '1',
              price,
              publishMarketFees.publishMarketFeeAddress,
              consumeMarketFixedSwapFee || '0'
            )
            steps.push({
              id: 'buy_datatokens',
              description: 'Buy 1 DT from fixed rate exchange (templateIndex=1).',
              tx: { ...buyTx, from: getAddress(from), chainId }
            })
            const startOrderTx = await (datatoken as any).startOrderTx(
              dtAddress,
              orderParams.consumer,
              orderParams.serviceIndex,
              orderParams._providerFee,
              orderParams._consumeMarketFee
            )
            steps.push({
              id: 'start_order',
              description:
                'Start order on datatoken after fixed-rate purchase (templateIndex=1).',
              tx: { ...startOrderTx, from: getAddress(from), chainId }
            })
          } else if (templateIndex === 2 || templateIndex === 4) {
            const freParams = {
              exchangeContract: frAddress,
              exchangeId: feesInfo.exchangeId,
              maxBaseTokenAmount: price,
              baseTokenAddress: exchange.baseToken,
              baseTokenDecimals: baseDecimals,
              swapMarketFee: consumeMarketFixedSwapFee || '0',
              marketFeeAddress: publishMarketFees.publishMarketFeeAddress
            } as any
            const txBuy = await (datatoken as any).buyFromFreAndOrderTx(
              dtAddress,
              orderParams,
              freParams
            )
            steps.push({
              id: 'buy_from_fre_and_order',
              description:
                'Buy from fixed rate exchange and start order in one tx (templateIndex=2/4).',
              tx: { ...txBuy, from: getAddress(from), chainId }
            })
          } else {
            throw new Error(
              `Unsupported datatoken templateIndex=${templateIndex} for fixed pricing.`
            )
          }
        } else {
          throw new Error('Pricing schema not supported.')
        }

        // Continuation logic: if caller provides lastTxHash, verify it exists/mined.
        const nextState = {
          index: state?.index ?? 0,
          txHashes: state?.txHashes ?? []
        }
        if (lastTxHash) {
          const receipt = await provider.getTransactionReceipt(lastTxHash)
          if (!receipt) {
            return commandResultPayload('order_asset', {
              status: 'waiting',
              reason: 'tx_not_mined_yet',
              lastTxHash,
              state: nextState
            })
          }
          nextState.txHashes = [...nextState.txHashes, lastTxHash]
          nextState.index = nextState.index + 1
        }

        const nextStep = steps[nextState.index]
        if (!nextStep) {
          return commandResultPayload('order_asset', {
            status: 'complete',
            state: nextState,
            steps: steps.map((s) => ({ id: s.id, description: s.description }))
          })
        }

        return commandResultPayload('order_asset', {
          status: 'needs_broadcast',
          state: nextState,
          step: {
            index: nextState.index,
            id: nextStep.id,
            description: nextStep.description,
            tx: normalizeTxRequest({ ...nextStep.tx, from: getAddress(from) })
          },
          steps: steps.map((s, i) => ({
            index: i,
            id: s.id,
            description: s.description
          })),
          next: {
            sign: 'Sign the returned `step.tx` offline (e.g. ethers Wallet.signTransaction(tx)).',
            broadcast:
              'Call broadcast_transaction with { chainId, txRaw }. Then call order_asset again with { state, lastTxHash }.'
          }
        })
      } catch (error) {
        return { ...textContent(stringifyError(error)), isError: true }
      }
    }
  )
}
