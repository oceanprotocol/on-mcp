import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { EscrowContract } from '@oceanprotocol/lib'
import { Contract, Wallet, formatUnits, getAddress } from 'ethers'
import { z } from 'zod/v4'

import type { EvmProviderRegistry } from '../evm/evmProviderRegistry.js'
import { stringifyError, textContent } from '../utils/format.js'
import { resolveConsumerAddress } from '../utils/auth.js'
import {
  commandResultPayload,
  getProviderOrThrow,
  getVoidSigner
} from './evmToolUtils.js'

/** Seconds of headroom added on top of the env max job duration when sizing an authorization. */
export const LOCK_DURATION_BUFFER_SECONDS = 86400 // 24h
/** Default number of concurrent jobs an authorization should be sized to cover. */
export const DEFAULT_PARALLEL_JOBS = 3
/** Deep link to the dashboard's escrow management view. */
export const MANAGE_ESCROW_URL = 'https://dashboard.oncompute.ai/profile/escrow'

const ERC20_DECIMALS_ABI = ['function decimals() view returns (uint8)']

/** `payment` object as returned by initializeCompute. Amounts are raw token base units. */
export type PaymentInfo = {
  escrowAddress: string
  chainId: number
  payee: string
  token: string
  amount: string | number
  minLockSeconds: string | number
}

export type EscrowPreflightResult = {
  /** Meets the generous provisioning targets (funds + authorization sized for parallelJobs). */
  ready: boolean
  /** Per-job feasibility the node enforces at createLock — the blocking condition. */
  canStartThisJob: boolean
  reason?: 'insufficient_funds' | 'missing_authorization' | 'authorization_limits'
  payer: string
  payee: string
  token: string
  chainId: number
  escrowAddress: string
  required: {
    amount: string
    parallelJobs: number
    maxLockedAmount: string
    maxLockSeconds: string
    maxLockCounts: string
    minLockSeconds: string
  }
  current: {
    funds: string
    authorization: {
      exists: boolean
      maxLockedAmount?: string
      currentLockedAmount?: string
      maxLockSeconds?: string
      maxLockCounts?: string
      currentLocks?: string
    }
  }
  shortfalls: string[]
  action?: { url: string; instructions: string }
}

/** Parsed escrow authorization (all uint256 fields as BigInt). */
export type EscrowAuthorizationView = {
  maxLockedAmount: bigint
  currentLockedAmount: bigint
  maxLockSeconds: bigint
  maxLockCounts: bigint
  currentLocks: bigint
}

/**
 * Side-effect-free escrow check shared by the `escrow_preflight` tool and the `computeStart`
 * gate. Reads on-chain funds + authorization for `payer`/`payee`, then delegates to the pure
 * `evaluateEscrowReadiness`. Never signs or sends a transaction.
 */
export async function runEscrowPreflight(params: {
  evmRegistry: EvmProviderRegistry
  payer: string
  payment: PaymentInfo
  maxJobDuration: number
  parallelJobs?: number
}): Promise<EscrowPreflightResult> {
  const { evmRegistry, payment, maxJobDuration } = params
  const parallelJobs = params.parallelJobs ?? DEFAULT_PARALLEL_JOBS
  const { chainId } = payment
  const payer = getAddress(params.payer)
  const payee = getAddress(payment.payee)
  const token = getAddress(payment.token)
  const escrowAddress = getAddress(payment.escrowAddress)

  // Read-only: a keyless VoidSigner is sufficient for getUserFunds / getAuthorizations.
  const signer = getVoidSigner(evmRegistry, chainId, payer) as never
  const escrow = new EscrowContract(escrowAddress, signer, chainId)

  const fundsRaw = await escrow.getUserFunds(payer, token)
  const available = BigInt(fundsRaw[0].toString())

  const auths = await escrow.getAuthorizations(token, payer, payee)
  const auth = auths && auths.length > 0 ? auths[0] : null
  const authorization: EscrowAuthorizationView | null = auth
    ? {
        maxLockedAmount: BigInt(auth[1].toString()),
        currentLockedAmount: BigInt(auth[2].toString()),
        maxLockSeconds: BigInt(auth[3].toString()),
        maxLockCounts: BigInt(auth[4].toString()),
        currentLocks: BigInt(auth[5].toString())
      }
    : null

  return evaluateEscrowReadiness({
    payer,
    payee,
    token,
    chainId,
    escrowAddress,
    amount: BigInt(String(payment.amount)),
    minLockSeconds: BigInt(String(payment.minLockSeconds)),
    maxJobDuration,
    parallelJobs,
    available,
    authorization
  })
}

/**
 * Pure escrow-readiness evaluation. Given already-fetched on-chain values, compares them against
 * the per-job minimums the node enforces (`canStartThisJob`, the blocking condition) and the
 * generous provisioning targets (`ready`). No I/O — see `runEscrowPreflight` for the on-chain read.
 */
export function evaluateEscrowReadiness(params: {
  payer: string
  payee: string
  token: string
  chainId: number
  escrowAddress: string
  amount: bigint
  minLockSeconds: bigint
  maxJobDuration: number
  parallelJobs: number
  available: bigint
  authorization: EscrowAuthorizationView | null
}): EscrowPreflightResult {
  const {
    payer,
    payee,
    token,
    chainId,
    escrowAddress,
    amount,
    minLockSeconds,
    maxJobDuration,
    parallelJobs,
    available
  } = params
  const parsed = params.authorization

  const requiredMaxLockedAmount = amount * BigInt(parallelJobs)
  const requiredMaxLockCounts = BigInt(parallelJobs)
  let requiredMaxLockSeconds =
    BigInt(maxJobDuration) + BigInt(LOCK_DURATION_BUFFER_SECONDS)
  if (requiredMaxLockSeconds < minLockSeconds) requiredMaxLockSeconds = minLockSeconds

  // Per-job feasibility (mirrors ocean-node createLock validation).
  const fundsCanStart = available >= amount
  const authExists = parsed !== null
  const headroom = parsed ? parsed.maxLockedAmount - parsed.currentLockedAmount : 0n
  const headroomCanStart = authExists && headroom >= amount
  const secondsCanStart = authExists && parsed!.maxLockSeconds >= minLockSeconds
  const countCanStart = authExists && parsed!.currentLocks + 1n <= parsed!.maxLockCounts
  const canStartThisJob =
    fundsCanStart && authExists && headroomCanStart && secondsCanStart && countCanStart

  // Generous provisioning targets (set once, reuse for many/long/parallel jobs).
  const fundsOk = available >= requiredMaxLockedAmount
  const authAmountOk = authExists && parsed!.maxLockedAmount >= requiredMaxLockedAmount
  const authSecondsOk = authExists && parsed!.maxLockSeconds >= requiredMaxLockSeconds
  const authCountsOk = authExists && parsed!.maxLockCounts >= requiredMaxLockCounts
  const ready =
    canStartThisJob && fundsOk && authAmountOk && authSecondsOk && authCountsOk

  const shortfalls: string[] = []
  if (!fundsOk) {
    shortfalls.push(
      `escrow funds ${available} < recommended ${requiredMaxLockedAmount} (covers ~${parallelJobs} parallel jobs)`
    )
  }
  if (!authExists) {
    shortfalls.push(`no escrow authorization for payee ${payee}`)
  } else {
    if (!authAmountOk) {
      shortfalls.push(
        `authorization maxLockedAmount ${parsed!.maxLockedAmount} < recommended ${requiredMaxLockedAmount}`
      )
    }
    if (!authSecondsOk) {
      shortfalls.push(
        `authorization maxLockSeconds ${parsed!.maxLockSeconds} < recommended ${requiredMaxLockSeconds}`
      )
    }
    if (!authCountsOk) {
      shortfalls.push(
        `authorization maxLockCounts ${parsed!.maxLockCounts} < recommended ${requiredMaxLockCounts}`
      )
    }
  }

  let reason: EscrowPreflightResult['reason']
  if (!canStartThisJob) {
    if (!fundsCanStart) reason = 'insufficient_funds'
    else if (!authExists) reason = 'missing_authorization'
    else reason = 'authorization_limits'
  }

  const action = ready
    ? undefined
    : {
        url: MANAGE_ESCROW_URL,
        instructions:
          `Open Manage escrow → deposit token ${token} and/or create an authorization for ` +
          `payee (node address) ${payee} with maxLockedAmount ≥ ${requiredMaxLockedAmount} ` +
          `(covers ~${parallelJobs} parallel jobs, each locks the full amount up front), ` +
          `maxLockSeconds ≥ ${requiredMaxLockSeconds} (env maxJobDuration + 24h), and ` +
          `maxLockCounts ≥ ${parallelJobs}. Amounts are raw base units — denominate with ` +
          `get_erc20_token_info(chainId=${chainId}, tokenAddress=${token}). Re-run escrow_preflight after.`
      }

  return {
    ready,
    canStartThisJob,
    reason,
    payer,
    payee,
    token,
    chainId,
    escrowAddress,
    required: {
      amount: amount.toString(),
      parallelJobs,
      maxLockedAmount: requiredMaxLockedAmount.toString(),
      maxLockSeconds: requiredMaxLockSeconds.toString(),
      maxLockCounts: requiredMaxLockCounts.toString(),
      minLockSeconds: minLockSeconds.toString()
    },
    current: {
      funds: available.toString(),
      authorization: parsed
        ? {
            exists: true,
            maxLockedAmount: parsed.maxLockedAmount.toString(),
            currentLockedAmount: parsed.currentLockedAmount.toString(),
            maxLockSeconds: parsed.maxLockSeconds.toString(),
            maxLockCounts: parsed.maxLockCounts.toString(),
            currentLocks: parsed.currentLocks.toString()
          }
        : { exists: false }
    },
    shortfalls,
    action
  }
}

async function getTokenDecimals(
  evmRegistry: EvmProviderRegistry,
  chainId: number,
  token: string
): Promise<number> {
  const provider = getProviderOrThrow(evmRegistry, chainId)
  const contract = new Contract(getAddress(token), ERC20_DECIMALS_ABI, provider)
  return Number(await contract.decimals())
}

/**
 * When a private key is available, deposit any shortfall and create a missing authorization so
 * the consumer is provisioned to the generous targets. Returns a list of executed actions.
 * Note: an *existing* authorization that is below target cannot be raised through ocean.js —
 * those cases fall back to the dashboard redirect.
 */
async function autoFixEscrow(params: {
  evmRegistry: EvmProviderRegistry
  privateKey: string
  result: EscrowPreflightResult
}): Promise<Array<{ action: string; amount?: string; tx?: string; note?: string }>> {
  const { evmRegistry, privateKey, result } = params
  const { chainId } = result
  const provider = getProviderOrThrow(evmRegistry, chainId)
  const wallet = new Wallet(privateKey, provider as never) as never
  const escrow = new EscrowContract(getAddress(result.escrowAddress), wallet, chainId)
  const decimals = await getTokenDecimals(evmRegistry, chainId, result.token)

  const actions: Array<{ action: string; amount?: string; tx?: string; note?: string }> =
    []

  const available = BigInt(result.current.funds)
  const targetFunds = BigInt(result.required.maxLockedAmount)
  if (available < targetFunds) {
    const depositHuman = formatUnits(targetFunds - available, decimals)
    const receipt: any = await escrow.deposit(result.token, depositHuman, decimals)
    actions.push({
      action: 'deposit',
      amount: depositHuman,
      tx: receipt?.hash ?? receipt?.transactionHash
    })
  }

  if (!result.current.authorization.exists) {
    const maxLockedHuman = formatUnits(BigInt(result.required.maxLockedAmount), decimals)
    const receipt: any = await escrow.authorize(
      result.token,
      result.payee,
      maxLockedHuman,
      result.required.maxLockSeconds,
      result.required.maxLockCounts,
      decimals
    )
    actions.push({
      action: 'authorize',
      tx: receipt?.hash ?? receipt?.transactionHash
    })
  } else if (!result.ready) {
    actions.push({
      action: 'authorize',
      note: 'Existing authorization is below the recommended targets and cannot be raised automatically — increase it via the dashboard.'
    })
  }

  return actions
}

type Params = { server: McpServer; evmRegistry: EvmProviderRegistry }

const paymentSchema = z
  .object({
    escrowAddress: z
      .string()
      .describe('Escrow contract address (from initializeCompute).'),
    chainId: z.number().int().positive(),
    payee: z.string().describe('Node payee address (initializeCompute payment.payee).'),
    token: z.string().describe('Payment/fee token address.'),
    amount: z
      .union([z.string(), z.number()])
      .describe('Per-job max lock amount in raw token base units (payment.amount).'),
    minLockSeconds: z
      .union([z.string(), z.number()])
      .describe('Escrow-lock requirement in seconds (payment.minLockSeconds).')
  })
  .describe('The `payment` object returned by initializeCompute.')

export function registerEscrowPreflightTool({ server, evmRegistry }: Params): void {
  server.registerTool(
    'escrow_preflight',
    {
      title: 'Escrow: preflight a paid compute job',
      description:
        'Checks whether a consumer is ready to pay for a compute job: resolves the consumer ' +
        '(payer) address from an authToken / privateKey / consumerAddress, then verifies escrow ' +
        'funds and the payee authorization against the job requirements.\n\n' +
        'Pass the `payment` object from initializeCompute and the chosen env `maxJobDuration`. ' +
        'Authorizations are sized generously — `maxLockedAmount ≥ amount × parallelJobs`, ' +
        '`maxLockSeconds ≥ maxJobDuration + 24h`, `maxLockCounts ≥ parallelJobs` — so they are set ' +
        'once and reused.\n\n' +
        'If not ready and a `privateKey` is supplied (autoFix), it deposits the shortfall and ' +
        'creates a missing authorization on-chain. Otherwise it returns a redirect to ' +
        `${MANAGE_ESCROW_URL} (Manage escrow). Amounts are raw base units — denominate with ` +
        'get_erc20_token_info before showing them.',
      inputSchema: {
        authToken: z
          .string()
          .optional()
          .describe(
            'JWT; its `address` claim is decoded (not verified) to get the payer.'
          ),
        privateKey: z
          .string()
          .optional()
          .describe(
            'Consumer key. Enables auto-fix (deposit + authorize). Testnet only — pasted keys transit the chat/LLM.'
          ),
        consumerAddress: z
          .string()
          .optional()
          .describe('Explicit payer address for a read-only check (no signing).'),
        payment: paymentSchema,
        maxJobDuration: z
          .number()
          .describe(
            "Chosen compute environment's maxJobDuration (from getComputeEnvironments)."
          ),
        parallelJobs: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            `Concurrent jobs to provision for (default ${DEFAULT_PARALLEL_JOBS}).`
          ),
        autoFix: z
          .boolean()
          .optional()
          .describe(
            'When a privateKey is supplied, deposit/authorize automatically (default true).'
          )
      }
    },
    async ({
      authToken,
      privateKey,
      consumerAddress,
      payment,
      maxJobDuration,
      parallelJobs,
      autoFix
    }) => {
      try {
        const payer = resolveConsumerAddress({ authToken, privateKey, consumerAddress })
        const paymentInfo = payment as PaymentInfo
        let result = await runEscrowPreflight({
          evmRegistry,
          payer,
          payment: paymentInfo,
          maxJobDuration,
          parallelJobs
        })

        let autoFixActions:
          | Array<{ action: string; amount?: string; tx?: string; note?: string }>
          | undefined
        const shouldAutoFix = !result.ready && !!privateKey && autoFix !== false
        if (shouldAutoFix) {
          autoFixActions = await autoFixEscrow({ evmRegistry, privateKey, result })
          result = await runEscrowPreflight({
            evmRegistry,
            payer,
            payment: paymentInfo,
            maxJobDuration,
            parallelJobs
          })
        }

        return commandResultPayload('escrow_preflight', {
          ...result,
          ...(autoFixActions ? { autoFix: autoFixActions } : {})
        })
      } catch (error) {
        return { ...textContent(stringifyError(error)), isError: true }
      }
    }
  )
}
