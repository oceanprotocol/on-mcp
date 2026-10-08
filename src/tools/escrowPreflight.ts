import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { EscrowContract } from '@oceanprotocol/lib'
import { Contract, Wallet, formatUnits, getAddress } from 'ethers'
import { z } from 'zod/v4'

import type { EvmProviderRegistry } from '../evm/evmProviderRegistry.js'
import {
  recordAutoFix,
  recordPreflight,
  recordPreflightError,
  type PreflightCaller
} from '../telemetry/escrowMetrics.js'
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
/** Assumed `claimDurationTimeout` when the node's real value is unknowable — see below. */
export const DEFAULT_CLAIM_DURATION_TIMEOUT_SECONDS = 3600

/**
 * `minLockSeconds` for a service of `durationSeconds`.
 *
 * ocean-node's rule is `Escrow.getMinLockTime(d) = d + claimDurationTimeout`
 * (`utils/escrow.ts:40`), where `claimDurationTimeout` is **per-node config**
 * (`schemas.ts:786`, `z.coerce.number().default(3600)`) that **no protocol command exposes**.
 * So this is a padded *lower bound*, not an equality — do NOT "simplify" it to a bare `+ 3600`:
 * on a node that raised the timeout, an exact-3600 figure would green-light a service whose
 * `createLock` then fails, with nothing in the output to explain why.
 *
 * The padding only affects the figure echoed to the caller; `escrow_preflight`'s own
 * authorization target (`maxJobDuration + 24h`) already dwarfs any plausible setting.
 */
export function serviceMinLockSeconds(durationSeconds: number): number {
  return (
    durationSeconds +
    Math.max(DEFAULT_CLAIM_DURATION_TIMEOUT_SECONDS, Math.ceil(0.25 * durationSeconds))
  )
}

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
  reason?:
    | 'insufficient_funds'
    | 'missing_authorization'
    | 'authorization_limits'
    | 'authorization_expired'
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
      /** Escrow v2: `0` = indefinite; a past value means the authorization can no longer lock. */
      expiryTimestamp?: string
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
  /**
   * Escrow v2: unix seconds after which the payee can no longer create/extend locks. `0n` =
   * indefinite (also the case on a pre-v2 escrow whose auth tuple has no expiry field).
   */
  expiryTimestamp: bigint
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
  /**
   * The consumer-selected subsidy providers for this job (tri-state, see ocean-node #1485). A
   * non-empty list means the lock may be (partly) sponsored, so the payer-funded guards are
   * relaxed — see `evaluateEscrowReadiness`.
   */
  subsidyProviders?: string[]
  /**
   * Which context invoked the check, for the `mcp.escrow.preflight{caller}` metric. Most
   * preflights are the implicit gates inside `computeStart`/`serviceStart`, not this tool — see
   * `telemetry/escrowMetrics.ts`.
   */
  caller?: PreflightCaller
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

  let available: bigint
  let authorization: EscrowAuthorizationView | null
  try {
    const fundsRaw = await escrow.getUserFunds(payer, token)
    available = BigInt(fundsRaw[0].toString())

    const auths = await escrow.getAuthorizations(token, payer, payee)
    const auth = auths && auths.length > 0 ? auths[0] : null
    authorization = auth
      ? {
          maxLockedAmount: BigInt(auth[1].toString()),
          currentLockedAmount: BigInt(auth[2].toString()),
          maxLockSeconds: BigInt(auth[3].toString()),
          maxLockCounts: BigInt(auth[4].toString()),
          currentLocks: BigInt(auth[5].toString()),
          // Escrow v2 added `expiryTimestamp` at index [6]; absent on a pre-v2 escrow ⇒ 0n (indefinite).
          expiryTimestamp: BigInt((auth[6] ?? 0).toString())
        }
      : null
  } catch (error) {
    // Both gates swallow their errors and proceed ("let the node decide"), so without this a broken
    // escrow RPC looks like *no preflight traffic* rather than a problem — silently biasing the
    // block-rate denominator. Record and rethrow; the callers' behaviour is unchanged.
    recordPreflightError(params.caller ?? 'tool')
    throw error
  }

  const result = evaluateEscrowReadiness({
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
    authorization,
    subsidyProviders: params.subsidyProviders
  })

  // Recorded here rather than in the tool wrapper: two of the three callers are gates, not tools.
  recordPreflight(result, params.caller ?? 'tool')
  return result
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
  /** Consumer-selected subsidy providers; a non-empty list may (partly) sponsor the lock. */
  subsidyProviders?: string[]
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
  // A lock with selected subsidy providers may be (partly) pre-funded: the payer only covers
  // `P = L − S`, which cannot be determined client-side without quoting the providers. Mirroring
  // ocean-node's `createLock`, skip the payer-funded guards (available-funds + the `maxLockedAmount`
  // cap, which in v2 tracks only `P`) for a sponsored lock and let the contract settle `P`
  // authoritatively; auth existence, lock-count, duration and expiry still apply. An explicit `[]`
  // (no providers) or an omitted selection stays payer-funded, so the guards are unchanged there.
  const sponsored =
    Array.isArray(params.subsidyProviders) && params.subsidyProviders.length > 0

  const requiredMaxLockedAmount = amount * BigInt(parallelJobs)
  const requiredMaxLockCounts = BigInt(parallelJobs)
  let requiredMaxLockSeconds =
    BigInt(maxJobDuration) + BigInt(LOCK_DURATION_BUFFER_SECONDS)
  if (requiredMaxLockSeconds < minLockSeconds) requiredMaxLockSeconds = minLockSeconds

  // Per-job feasibility (mirrors ocean-node createLock validation). The payer-funded guards
  // (funds + headroom) are skipped for a sponsored lock — see the `sponsored` note above.
  const fundsCanStart = sponsored || available >= amount
  const authExists = parsed !== null
  const headroom = parsed ? parsed.maxLockedAmount - parsed.currentLockedAmount : 0n
  const headroomCanStart = sponsored || (authExists && headroom >= amount)
  const secondsCanStart = authExists && parsed!.maxLockSeconds >= minLockSeconds
  const countCanStart = authExists && parsed!.currentLocks + 1n <= parsed!.maxLockCounts
  // Escrow v2 authorization expiry (optimistic, wall-clock pre-check; the on-chain block.timestamp
  // stays authoritative). A non-zero `expiryTimestamp` gates new locks: the auth is unusable once
  // past it, and a lock may not end beyond it (it can never outlive its auth). `0` = indefinite,
  // also the case on a pre-v2 escrow — so this is a no-op there. Mirrors ocean-node utils/escrow.ts.
  const nowSec = BigInt(Math.floor(Date.now() / 1000))
  const expiry = authExists ? parsed!.expiryTimestamp : 0n
  const authExpired = authExists && expiry > 0n && nowSec > expiry
  const lockOutlivesExpiry = authExists && expiry > 0n && nowSec + minLockSeconds > expiry
  const expiryCanStart = authExists && !authExpired && !lockOutlivesExpiry
  const canStartThisJob =
    fundsCanStart &&
    authExists &&
    headroomCanStart &&
    secondsCanStart &&
    countCanStart &&
    expiryCanStart

  // Generous provisioning targets (set once, reuse for many/long/parallel jobs). The payer-funded
  // amount targets are advisory-only and not meaningful for a sponsored lock, so treat them as met.
  const fundsOk = sponsored || available >= requiredMaxLockedAmount
  const authAmountOk =
    sponsored || (authExists && parsed!.maxLockedAmount >= requiredMaxLockedAmount)
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
    // Per-job blockers (can be hit even when the recommended targets above pass).
    if (!headroomCanStart) {
      shortfalls.push(
        `authorization headroom ${headroom} (maxLockedAmount ${parsed!.maxLockedAmount} − currentLockedAmount ${parsed!.currentLockedAmount}) < ${amount} needed to start this job`
      )
    }
    if (!countCanStart) {
      shortfalls.push(
        `authorization has no free lock slot: currentLocks ${parsed!.currentLocks} + 1 > maxLockCounts ${parsed!.maxLockCounts}`
      )
    }
    if (authExpired) {
      shortfalls.push(
        `authorization expired: expiryTimestamp ${expiry} < now ${nowSec} (re-authorize with escrow_authorize to renew)`
      )
    } else if (lockOutlivesExpiry) {
      shortfalls.push(
        `lock would outlive authorization expiry: now ${nowSec} + minLockSeconds ${minLockSeconds} > expiryTimestamp ${expiry}`
      )
    }
  }

  let reason: EscrowPreflightResult['reason']
  if (!canStartThisJob) {
    if (!fundsCanStart) reason = 'insufficient_funds'
    else if (!authExists) reason = 'missing_authorization'
    else if (authExpired || lockOutlivesExpiry) reason = 'authorization_expired'
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
            currentLocks: parsed.currentLocks.toString(),
            expiryTimestamp: parsed.expiryTimestamp.toString()
          }
        : { exists: false }
    },
    shortfalls,
    action
  }
}

export async function getTokenDecimals(
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
      // Escrow v2 added `expiryTimestamp` before `tokenDecimals`; '0' = indefinite (today's behaviour).
      '0',
      decimals
    )
    actions.push({
      action: 'authorize',
      tx: receipt?.hash ?? receipt?.transactionHash
    })
  } else if (result.reason === 'authorization_expired') {
    // Escrow v2 `authorize` OVERWRITES an existing authorization, so a past-expiry (effectively
    // revoked) auth can be renewed in place — re-authorize to the targets with a fresh indefinite
    // expiry ('0'). This path was impossible pre-v2 (authorize no-op'd on an existing auth).
    const maxLockedHuman = formatUnits(BigInt(result.required.maxLockedAmount), decimals)
    const receipt: any = await escrow.authorize(
      result.token,
      result.payee,
      maxLockedHuman,
      result.required.maxLockSeconds,
      result.required.maxLockCounts,
      '0',
      decimals
    )
    actions.push({
      action: 'authorize',
      note: 'Renewed an expired authorization (reset expiry to indefinite).',
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
      .union([
        z.string().regex(/^[1-9]\d*$/, 'positive integer string (raw base units)'),
        z.number().int().positive()
      ])
      .describe('Per-job max lock amount in raw token base units (payment.amount).'),
    minLockSeconds: z
      .union([
        z.string().regex(/^[1-9]\d*$/, 'positive integer string (seconds)'),
        z.number().int().positive()
      ])
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
          .int()
          .positive()
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
          recordAutoFix(autoFixActions)
          result = await runEscrowPreflight({
            evmRegistry,
            payer,
            payment: paymentInfo,
            maxJobDuration,
            parallelJobs,
            caller: 'tool_recheck'
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
