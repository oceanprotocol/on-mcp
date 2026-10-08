import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { EscrowContract, EscrowKind } from '@oceanprotocol/lib'
import { getAddress } from 'ethers'
import { z } from 'zod/v4'

import type { EvmProviderRegistry } from '../evm/evmProviderRegistry.js'
import { stringifyError, textContent } from '../utils/format.js'
import {
  commandResultPayload,
  contractInputSchema,
  getVoidSigner,
  normalizeTxRequest,
  unsignedTxInputSchema
} from './evmToolUtils.js'

type Params = {
  server: McpServer
  evmRegistry: EvmProviderRegistry
}

function getEscrow(
  evmRegistry: EvmProviderRegistry,
  chainId: number,
  contractAddress: string,
  from?: string
): EscrowContract {
  const signer = getVoidSigner(evmRegistry, chainId, from) as any
  return new EscrowContract(getAddress(contractAddress), signer, chainId)
}

export function registerEscrowTools({ server, evmRegistry }: Params): void {
  server.registerTool(
    'escrow_get_funds',
    {
      title: 'Escrow: get token funds',
      description:
        'Reads total escrowed funds for a payment token from an Escrow contract (read-only).',
      inputSchema: {
        ...contractInputSchema,
        token: z.string().describe('Payment token address.')
      }
    },
    async ({ chainId, contractAddress, token }) => {
      try {
        const escrow = getEscrow(evmRegistry, chainId, contractAddress)
        const result = await escrow.getFunds(getAddress(token))
        return commandResultPayload('escrow_get_funds', result)
      } catch (error) {
        return { ...textContent(stringifyError(error)), isError: true }
      }
    }
  )

  server.registerTool(
    'escrow_get_user_funds',
    {
      title: 'Escrow: get user funds',
      description:
        'Reads escrowed funds for a payer and token from Escrow.getUserFunds (read-only). ' +
        'Returns `{ available, locked }`. NOTE (Escrow v2): `locked` tracks only the payer-funded ' +
        'portion `P` — tokens a provider pre-funded (sponsored `S`) are in a separate bucket ' +
        '(escrow_get_sponsored_total / escrow_get_sponsorship) and are NOT counted here, so ' +
        '`locked` no longer equals the sum of escrow_get_locks amounts.',
      inputSchema: {
        ...contractInputSchema,
        payer: z.string().describe('Payer address.'),
        token: z.string().describe('Payment token address.')
      }
    },
    async ({ chainId, contractAddress, payer, token }) => {
      try {
        const escrow = getEscrow(evmRegistry, chainId, contractAddress)
        const result = await escrow.getUserFunds(getAddress(payer), getAddress(token))
        return commandResultPayload('escrow_get_user_funds', result)
      } catch (error) {
        return { ...textContent(stringifyError(error)), isError: true }
      }
    }
  )

  server.registerTool(
    'escrow_get_user_tokens',
    {
      title: 'Escrow: get user tokens',
      description:
        'Reads payment token addresses for which the payer has escrow records via Escrow.getUserTokens (read-only).',
      inputSchema: {
        ...contractInputSchema,
        payer: z.string().describe('Payer address.')
      }
    },
    async ({ chainId, contractAddress, payer }) => {
      try {
        const escrow = getEscrow(evmRegistry, chainId, contractAddress)
        const result = await escrow.getUserTokens(getAddress(payer))
        return commandResultPayload('escrow_get_user_tokens', result)
      } catch (error) {
        return { ...textContent(stringifyError(error)), isError: true }
      }
    }
  )

  server.registerTool(
    'escrow_get_locks',
    {
      title: 'Escrow: get locks',
      description:
        'Reads escrow locks for token + payer + payee via Escrow.getLocks (read-only). ' +
        'Each lock `amount` is the GROSS lock `L` (payer-funded `P` + sponsored `S`); the ' +
        'sponsored breakdown is in escrow_get_sponsorship. Escrow v2 locks also carry `startTime`.',
      inputSchema: {
        ...contractInputSchema,
        token: z.string().describe('Payment token address.'),
        payer: z.string().describe('Payer address.'),
        payee: z.string().describe('Payee address.')
      }
    },
    async ({ chainId, contractAddress, token, payer, payee }) => {
      try {
        const escrow = getEscrow(evmRegistry, chainId, contractAddress)
        const result = await escrow.getLocks(
          getAddress(token),
          getAddress(payer),
          getAddress(payee)
        )
        return commandResultPayload('escrow_get_locks', result)
      } catch (error) {
        return { ...textContent(stringifyError(error)), isError: true }
      }
    }
  )

  server.registerTool(
    'escrow_get_authorizations',
    {
      title: 'Escrow: get authorizations',
      description:
        'Reads escrow authorizations for token + payer + payee via Escrow.getAuthorizations ' +
        '(read-only). Each entry is a tuple `[payee, maxLockedAmount, currentLockedAmount, ' +
        'maxLockSeconds, maxLockCounts, currentLocks, expiryTimestamp]`. NOTE (Escrow v2): ' +
        '`currentLockedAmount` reflects only the payer-funded portion `P`, and `expiryTimestamp` ' +
        '(unix seconds; `0` = indefinite) is the time after which the payee can no longer ' +
        'create/extend locks (a past value means the authorization is effectively revoked).',
      inputSchema: {
        ...contractInputSchema,
        token: z.string().describe('Payment token address.'),
        payer: z.string().describe('Payer address.'),
        payee: z.string().describe('Payee address.')
      }
    },
    async ({ chainId, contractAddress, token, payer, payee }) => {
      try {
        const escrow = getEscrow(evmRegistry, chainId, contractAddress)
        const result = await escrow.getAuthorizations(
          getAddress(token),
          getAddress(payer),
          getAddress(payee)
        )
        return commandResultPayload('escrow_get_authorizations', result)
      } catch (error) {
        return { ...textContent(stringifyError(error)), isError: true }
      }
    }
  )

  server.registerTool(
    'escrow_deposit',
    {
      title: 'Escrow: deposit funds',
      description:
        'Builds an unsigned transaction for Escrow.deposit.\n\nThis tool NEVER signs or broadcasts. To execute:\n- Sign the returned TransactionRequest offline using your wallet.\n- Broadcast it via broadcast_transaction(chainId, txRaw).',
      inputSchema: {
        ...contractInputSchema,
        ...unsignedTxInputSchema,
        token: z.string().describe('Payment token address.'),
        amount: z
          .string()
          .describe(
            'Human-readable token amount as expected by ocean.js contract wrapper.'
          ),
        tokenDecimals: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Optional token decimals override.')
      }
    },
    async ({ chainId, contractAddress, from, token, amount, tokenDecimals }) => {
      try {
        const escrow = getEscrow(evmRegistry, chainId, contractAddress, from)
        const tx = await escrow.depositTx(getAddress(token), amount, tokenDecimals)
        return commandResultPayload('escrow_deposit', {
          chainId,
          from: getAddress(from),
          tx: normalizeTxRequest({ ...tx, from: getAddress(from) }),
          next: {
            sign: 'Sign `tx` offline (e.g. ethers Wallet.signTransaction(tx)).',
            broadcast:
              'Call broadcast_transaction with { chainId, txRaw } where txRaw is the signed serialized transaction.'
          }
        })
      } catch (error) {
        return { ...textContent(stringifyError(error)), isError: true }
      }
    }
  )

  server.registerTool(
    'escrow_withdraw',
    {
      title: 'Escrow: withdraw funds',
      description:
        'Builds an unsigned transaction for Escrow.withdraw(tokens, amounts).\n\nThis tool NEVER signs or broadcasts. To execute:\n- Sign the returned TransactionRequest offline using your wallet.\n- Broadcast it via broadcast_transaction(chainId, txRaw).',
      inputSchema: {
        ...contractInputSchema,
        ...unsignedTxInputSchema,
        tokens: z.array(z.string()).describe('Payment token addresses.'),
        amounts: z
          .array(z.string())
          .describe('Token amounts aligned with `tokens` (human-readable strings).'),
        tokenDecimals: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Optional token decimals override.')
      }
    },
    async ({ chainId, contractAddress, from, tokens, amounts, tokenDecimals }) => {
      try {
        const tokensNorm = tokens.map((token) => getAddress(token))
        const escrow = getEscrow(evmRegistry, chainId, contractAddress, from)
        const tx = await escrow.withdrawTx(tokensNorm, amounts, tokenDecimals)
        return commandResultPayload('escrow_withdraw', {
          chainId,
          from: getAddress(from),
          tx: normalizeTxRequest({ ...tx, from: getAddress(from) }),
          next: {
            sign: 'Sign `tx` offline (e.g. ethers Wallet.signTransaction(tx)).',
            broadcast:
              'Call broadcast_transaction with { chainId, txRaw } where txRaw is the signed serialized transaction.'
          }
        })
      } catch (error) {
        return { ...textContent(stringifyError(error)), isError: true }
      }
    }
  )

  server.registerTool(
    'escrow_authorize',
    {
      title: 'Escrow: authorize / renew / revoke payee',
      description:
        'Builds an unsigned transaction for Escrow.authorize(token, payee, maxLockedAmount, maxLockSeconds, maxLockCounts, expiryTimestamp).\n\n' +
        'Escrow v2: this both CREATES and UPDATES an authorization (it no longer no-ops when one already exists), so it is also how you renew/shorten limits or REVOKE — re-authorize with a past `expiryTimestamp` (existing locks stay claimable/cancellable).\n\n' +
        'This tool NEVER signs or broadcasts. To execute:\n- Sign the returned TransactionRequest offline using your wallet.\n- Broadcast it via broadcast_transaction(chainId, txRaw).',
      inputSchema: {
        ...contractInputSchema,
        ...unsignedTxInputSchema,
        token: z.string().describe('Payment token address.'),
        payee: z.string().describe('Payee address to authorize.'),
        maxLockedAmount: z
          .string()
          .describe('Maximum lockable amount (human-readable string).'),
        maxLockSeconds: z.string().describe('Maximum lock duration in seconds (string).'),
        maxLockCounts: z.string().describe('Maximum number of locks (string).'),
        expiryTimestamp: z
          .string()
          .optional()
          .describe(
            'Escrow v2: unix timestamp (seconds) after which the payee can no longer create/extend ' +
              'locks. "0" (default) = indefinite. A past value revokes. Claim/cancel are never gated by it.'
          ),
        tokenDecimals: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Optional token decimals override.')
      }
    },
    async ({
      chainId,
      contractAddress,
      from,
      token,
      payee,
      maxLockedAmount,
      maxLockSeconds,
      maxLockCounts,
      expiryTimestamp,
      tokenDecimals
    }) => {
      try {
        const escrow = getEscrow(evmRegistry, chainId, contractAddress, from)
        const tx = await escrow.authorizeTx(
          getAddress(token),
          getAddress(payee),
          maxLockedAmount,
          maxLockSeconds,
          maxLockCounts,
          expiryTimestamp ?? '0',
          tokenDecimals
        )
        return commandResultPayload('escrow_authorize', {
          chainId,
          from: getAddress(from),
          tx: normalizeTxRequest({ ...tx, from: getAddress(from) }),
          next: {
            sign: 'Sign `tx` offline (e.g. ethers Wallet.signTransaction(tx)).',
            broadcast:
              'Call broadcast_transaction with { chainId, txRaw } where txRaw is the signed serialized transaction.'
          }
        })
      } catch (error) {
        return { ...textContent(stringifyError(error)), isError: true }
      }
    }
  )

  // ---- Escrow v2: lock-time prepaid sponsorship reads ------------------------------------------

  server.registerTool(
    'escrow_get_sponsorship',
    {
      title: 'Escrow: get lock sponsorship',
      description:
        'Escrow v2: reads the per-lock sponsorship breakdown via Escrow.getSponsorship (read-only). ' +
        'Returns `{ total, providers[], amounts[] }` (amounts in human-readable token units) — the ' +
        'providers that pre-funded this lock and each share. A plain (unsponsored) lock returns total ' +
        '"0" and empty arrays.',
      inputSchema: {
        ...contractInputSchema,
        payee: z.string().describe('Payee (node) address.'),
        payer: z.string().describe('Payer address.'),
        jobId: z.string().describe('Job id of the lock.'),
        token: z
          .string()
          .describe("The lock's token address (used only to resolve decimals)."),
        tokenDecimals: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Optional token decimals override.')
      }
    },
    async ({ chainId, contractAddress, payee, payer, jobId, token, tokenDecimals }) => {
      try {
        const escrow = getEscrow(evmRegistry, chainId, contractAddress)
        const result = await escrow.getSponsorship(
          getAddress(payee),
          getAddress(payer),
          jobId,
          getAddress(token),
          tokenDecimals
        )
        return commandResultPayload('escrow_get_sponsorship', result)
      } catch (error) {
        return { ...textContent(stringifyError(error)), isError: true }
      }
    }
  )

  server.registerTool(
    'escrow_get_sponsored_total',
    {
      title: 'Escrow: get sponsored total',
      description:
        'Escrow v2: reads the total tokens held in the non-withdrawable sponsored bucket for a ' +
        'token via Escrow.getSponsoredTotal (read-only). Returns a human-readable amount.',
      inputSchema: {
        ...contractInputSchema,
        token: z.string().describe('Payment token address.'),
        tokenDecimals: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Optional token decimals override.')
      }
    },
    async ({ chainId, contractAddress, token, tokenDecimals }) => {
      try {
        const escrow = getEscrow(evmRegistry, chainId, contractAddress)
        const result = await escrow.getSponsoredTotal(getAddress(token), tokenDecimals)
        return commandResultPayload('escrow_get_sponsored_total', result)
      } catch (error) {
        return { ...textContent(stringifyError(error)), isError: true }
      }
    }
  )

  server.registerTool(
    'escrow_get_reclaimable',
    {
      title: 'Escrow: get reclaimable sponsorship',
      description:
        'Escrow v2: reads the amount a provider can sweep back (failed push-back refunds parked ' +
        'for later pull) for a token via Escrow.getReclaimable (read-only). Returns a ' +
        'human-readable amount. Use escrow_sweep_reclaimable to pull it.',
      inputSchema: {
        ...contractInputSchema,
        provider: z.string().describe('Provider (sponsor) address.'),
        token: z.string().describe('Payment token address.'),
        tokenDecimals: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Optional token decimals override.')
      }
    },
    async ({ chainId, contractAddress, provider, token, tokenDecimals }) => {
      try {
        const escrow = getEscrow(evmRegistry, chainId, contractAddress)
        const result = await escrow.getReclaimable(
          getAddress(provider),
          getAddress(token),
          tokenDecimals
        )
        return commandResultPayload('escrow_get_reclaimable', result)
      } catch (error) {
        return { ...textContent(stringifyError(error)), isError: true }
      }
    }
  )

  server.registerTool(
    'escrow_get_info',
    {
      title: 'Escrow: capabilities & kind',
      description:
        'Escrow v2 discovery (read-only): reports the escrow `version`, `escrowKind` ' +
        '(COMMUNITY/ENTERPRISE), `maxSponsorsPerLock`, and ERC-165 capability flags (isEscrowCore, ' +
        'isEscrowLockSubsidy, isEscrowEnterprise). Safe against a legacy (pre-v2) escrow: ' +
        'unsupported reads come back false/null instead of throwing. For an enterprise escrow it ' +
        'also returns feeCollector and (when a token is given) isTokenAllowed.',
      inputSchema: {
        ...contractInputSchema,
        token: z
          .string()
          .optional()
          .describe(
            'Optional token to also check isTokenAllowed (enterprise escrow only).'
          )
      }
    },
    async ({ chainId, contractAddress, token }) => {
      try {
        const escrow = getEscrow(evmRegistry, chainId, contractAddress)
        const [isEscrowCore, isEscrowLockSubsidy, isEscrowEnterprise] = await Promise.all(
          [
            escrow.isEscrowCore(),
            escrow.isEscrowLockSubsidy(),
            escrow.isEscrowEnterprise()
          ]
        )
        // `version`/`escrowKind`/`maxSponsorsPerLock` only exist on a v2 escrow; guard behind the
        // IEscrowCore capability so a legacy escrow reports cleanly instead of throwing.
        let version: number | null = null
        let escrowKind: string | null = null
        let maxSponsorsPerLock: number | null = null
        if (isEscrowCore) {
          const [v, kind, cap] = await Promise.all([
            escrow.version(),
            escrow.escrowKind(),
            escrow.maxSponsorsPerLock()
          ])
          version = v
          escrowKind = EscrowKind[kind] ?? String(kind)
          maxSponsorsPerLock = cap
        }
        let feeCollector: string | null = null
        let isTokenAllowed: boolean | null = null
        if (isEscrowEnterprise) {
          feeCollector = await escrow.feeCollector()
          if (token) isTokenAllowed = await escrow.isTokenAllowed(getAddress(token))
        }
        return commandResultPayload('escrow_get_info', {
          version,
          escrowKind,
          maxSponsorsPerLock,
          isEscrowCore,
          isEscrowLockSubsidy,
          isEscrowEnterprise,
          feeCollector,
          isTokenAllowed
        })
      } catch (error) {
        return { ...textContent(stringifyError(error)), isError: true }
      }
    }
  )

  server.registerTool(
    'escrow_preview_fee',
    {
      title: 'Escrow: preview enterprise fee',
      description:
        'Escrow v2 (ENTERPRISE escrow only): previews the enterprise fee charged on a gross lock ' +
        'amount via Escrow.previewFee (read-only). Returns a human-readable amount (0 when no fee ' +
        'collector is configured). The community escrow does not support this.',
      inputSchema: {
        ...contractInputSchema,
        token: z.string().describe('Payment token address.'),
        amount: z.string().describe('Gross lock amount (human-readable token units).'),
        tokenDecimals: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Optional token decimals override.')
      }
    },
    async ({ chainId, contractAddress, token, amount, tokenDecimals }) => {
      try {
        const escrow = getEscrow(evmRegistry, chainId, contractAddress)
        const result = await escrow.previewFee(getAddress(token), amount, tokenDecimals)
        return commandResultPayload('escrow_preview_fee', result)
      } catch (error) {
        return { ...textContent(stringifyError(error)), isError: true }
      }
    }
  )

  server.registerTool(
    'escrow_sweep_reclaimable',
    {
      title: 'Escrow: sweep reclaimable sponsorship',
      description:
        'Escrow v2: builds an unsigned transaction for Escrow.sweepReclaimable(token) — a provider ' +
        'pulls its parked failed-refund sponsorship tokens.\n\nThis tool NEVER signs or broadcasts. ' +
        'To execute:\n- Sign the returned TransactionRequest offline using your wallet.\n- Broadcast ' +
        'it via broadcast_transaction(chainId, txRaw).',
      inputSchema: {
        ...contractInputSchema,
        ...unsignedTxInputSchema,
        token: z.string().describe('Payment token address.')
      }
    },
    async ({ chainId, contractAddress, from, token }) => {
      try {
        const escrow = getEscrow(evmRegistry, chainId, contractAddress, from)
        const tx = await escrow.sweepReclaimableTx(getAddress(token))
        return commandResultPayload('escrow_sweep_reclaimable', {
          chainId,
          from: getAddress(from),
          tx: normalizeTxRequest({ ...tx, from: getAddress(from) }),
          next: {
            sign: 'Sign `tx` offline (e.g. ethers Wallet.signTransaction(tx)).',
            broadcast:
              'Call broadcast_transaction with { chainId, txRaw } where txRaw is the signed serialized transaction.'
          }
        })
      } catch (error) {
        return { ...textContent(stringifyError(error)), isError: true }
      }
    }
  )
}
