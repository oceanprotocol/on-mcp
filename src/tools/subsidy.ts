import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
  isUnsupportedInterfaceError,
  OneTimeSubsidyProvider,
  OPFSubsidyProvider,
  SubsidyKind,
  SubsidyMode,
  SubsidyModeConfig,
  SubsidyView
} from '@oceanprotocol/lib'
import { getAddress } from 'ethers'
import { z } from 'zod/v4'

import type { EvmProviderRegistry } from '../evm/evmProviderRegistry.js'
import { stringifyError, textContent } from '../utils/format.js'
import {
  commandResultPayload,
  contractInputSchema,
  getVoidSigner
} from './evmToolUtils.js'

type Params = {
  server: McpServer
  evmRegistry: EvmProviderRegistry
}

function getSubsidyView(
  evmRegistry: EvmProviderRegistry,
  chainId: number,
  contractAddress: string
): SubsidyView {
  const signer = getVoidSigner(evmRegistry, chainId) as any
  // NOTE: SubsidyView's constructor is (signer, address, network) — signer first, unlike EscrowContract.
  return new SubsidyView(signer, getAddress(contractAddress), chainId)
}

/**
 * Run a read that may revert because the contract does not implement the method; report null for
 * that case only. Genuine RPC/network failures are RE-THROWN so they surface as the tool's error
 * response instead of being silently reported as "unsupported" — same distinction the library's
 * ERC-165 feature checks use (`isUnsupportedInterfaceError`: on-chain revert / empty data / missing
 * ABI method).
 */
async function safe<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read()
  } catch (error) {
    if (isUnsupportedInterfaceError(error)) return null
    throw error
  }
}

/**
 * Subsidy-provider reads (ocean.js `SubsidyView`). A subsidy provider can cover part of a compute /
 * service lock — either as a claim-time REIMBURSEMENT (v1) or a lock-time PREFUNDED sponsorship
 * (Escrow v2). These read tools let a consumer discover a provider's mode, budget and allow-lists
 * before selecting it via the `subsidyProviders` argument on computeStart / serviceStart /
 * serviceExtend.
 */
export function registerSubsidyTools({ server, evmRegistry }: Params): void {
  server.registerTool(
    'subsidy_get_info',
    {
      title: 'Subsidy: provider capabilities & config',
      description:
        'Reads a subsidy provider contract (SubsidyView, read-only): its `version`, `subsidyKind` ' +
        '(ROLLING_WINDOW/ONE_TIME/OTHER), `subsidyModeConfig` (BOTH/REFUND_ONLY/PREPAID_ONLY), ERC-165 ' +
        'capability flags (isSubsidyView, isSubsidyProvider, isSubsidyModeConfig, isSubsidyLockProvider), ' +
        'allowed job types, and the token `availableBalance`. Pass `token` to also read the per-token ' +
        '`tokenConfig` (keyed on subsidyKind: ONE_TIME -> getTokenConfig {pctBps, defaultCredit, enabled}; ' +
        'ROLLING_WINDOW -> getTokenLimits {pctBps, daily, weekly, monthly, enabled}). `pctBps` is the ' +
        'per-job ceiling in basis points (0 = grant nothing, 10000 = up to 100% of the job). Pass ' +
        '`payer`/`node` to also check isUserAllowed/isNodeAllowed. Unsupported reads come back null ' +
        'instead of throwing.',
      inputSchema: {
        ...contractInputSchema,
        token: z
          .string()
          .optional()
          .describe('Optional token to read the provider availableBalance for.'),
        payer: z
          .string()
          .optional()
          .describe('Optional payer address to check isUserAllowed.'),
        node: z
          .string()
          .optional()
          .describe('Optional node address to check isNodeAllowed.'),
        tokenDecimals: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Optional token decimals override (for availableBalance).')
      }
    },
    async ({ chainId, contractAddress, token, payer, node, tokenDecimals }) => {
      try {
        const view = getSubsidyView(evmRegistry, chainId, contractAddress)
        const [
          isSubsidyView,
          isSubsidyProvider,
          isSubsidyModeConfig,
          isSubsidyLockProvider
        ] = await Promise.all([
          view.isSubsidyView(),
          view.isSubsidyProvider(),
          view.isSubsidyModeConfig(),
          view.isSubsidyLockProvider()
        ])
        const versionNum = await safe(() => view.version())
        const kind = await safe(() => view.subsidyKind())
        const modeConfig = isSubsidyModeConfig
          ? await safe(() => view.subsidyModeConfig())
          : null
        // Per-token config lives on the kind-specific wrapper, not on the generic SubsidyView:
        // ONE_TIME -> getTokenConfig, ROLLING_WINDOW (OPF) -> getTokenLimits. safe() maps an
        // unsupported read (wrong kind / provider without the method) to null.
        const signer = getVoidSigner(evmRegistry, chainId) as any
        const addr = getAddress(contractAddress)
        const tokenConfig =
          token && kind === SubsidyKind.ONE_TIME
            ? await safe(() =>
                new OneTimeSubsidyProvider(signer, addr, chainId).getTokenConfig(
                  getAddress(token),
                  tokenDecimals
                )
              )
            : token && kind === SubsidyKind.ROLLING_WINDOW
              ? await safe(() =>
                  new OPFSubsidyProvider(signer, addr, chainId).getTokenLimits(
                    getAddress(token),
                    tokenDecimals
                  )
                )
              : null
        return commandResultPayload('subsidy_get_info', {
          version: versionNum,
          subsidyKind: kind === null ? null : (SubsidyKind[kind] ?? String(kind)),
          subsidyModeConfig:
            modeConfig === null
              ? null
              : (SubsidyModeConfig[modeConfig] ?? String(modeConfig)),
          isSubsidyView,
          isSubsidyProvider,
          isSubsidyModeConfig,
          isSubsidyLockProvider,
          tokenConfig,
          allowedJobTypes: await safe(() => view.getAllowedJobTypes()),
          availableBalance: token
            ? await safe(() => view.availableBalance(getAddress(token), tokenDecimals))
            : null,
          isUserAllowed: payer
            ? await safe(() => view.isUserAllowed(getAddress(payer)))
            : null,
          isNodeAllowed: node
            ? await safe(() => view.isNodeAllowed(getAddress(node)))
            : null
        })
      } catch (error) {
        return { ...textContent(stringifyError(error)), isError: true }
      }
    }
  )

  server.registerTool(
    'subsidy_quote',
    {
      title: 'Subsidy: quote prepaid vs refund',
      description:
        'Quotes how much a subsidy provider would cover for a job (SubsidyView, read-only). By ' +
        'default returns both delivery modes side by side via quoteSubsidyModes — REIMBURSEMENT ' +
        '(claim-time, payer still fronts funds) and PREFUNDED (lock-time sponsorship, reduces the ' +
        'payer deposit). Pass `mode` for a single-mode quote (quoteSubsidyByMode). Amounts are in ' +
        'human-readable token units.',
      inputSchema: {
        ...contractInputSchema,
        node: z.string().describe('Node (payee) address.'),
        payer: z.string().describe('Payer address.'),
        jobType: z
          .union([z.number().int().nonnegative(), z.string()])
          .describe('Job type (e.g. 1=COMPUTE, 2=SERVICE as ocean-node defines them).'),
        token: z.string().describe('Payment token address.'),
        amount: z.string().describe('Gross lock amount (human-readable token units).'),
        subsidyNeeded: z
          .string()
          .describe('Subsidy amount requested (human-readable token units).'),
        mode: z
          .enum(['REIMBURSEMENT', 'PREFUNDED'])
          .optional()
          .describe('Optional: quote a single delivery mode instead of both.'),
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
      node,
      payer,
      jobType,
      token,
      amount,
      subsidyNeeded,
      mode,
      tokenDecimals
    }) => {
      try {
        const view = getSubsidyView(evmRegistry, chainId, contractAddress)
        // quoteSubsidyModes / quoteSubsidyByMode are ISubsidyViewV2-only; they revert on a v1
        // provider. Feature-detect first and fall back to the v1 single-mode quote where possible.
        const isV2 = await view.isSubsidyViewV2()
        if (!isV2) {
          if (mode === 'REIMBURSEMENT') {
            const result = await view.quoteSubsidy(
              getAddress(node),
              getAddress(payer),
              jobType,
              getAddress(token),
              amount,
              subsidyNeeded,
              tokenDecimals
            )
            return commandResultPayload('subsidy_quote', result)
          }
          // PREFUNDED is a v2-only (lock-time) mode, and dual-mode quoting needs v2 — a v1 provider
          // can only answer the claim-time REIMBURSEMENT quote.
          throw new Error(
            'This subsidy provider does not implement ISubsidyViewV2: only the v1 claim-time ' +
              'quote is available. Re-call with mode="REIMBURSEMENT".'
          )
        }
        if (mode) {
          const result = await view.quoteSubsidyByMode(
            getAddress(node),
            getAddress(payer),
            jobType,
            getAddress(token),
            amount,
            subsidyNeeded,
            SubsidyMode[mode],
            tokenDecimals
          )
          return commandResultPayload('subsidy_quote', result)
        }
        const result = await view.quoteSubsidyModes(
          getAddress(node),
          getAddress(payer),
          jobType,
          getAddress(token),
          amount,
          subsidyNeeded,
          tokenDecimals
        )
        return commandResultPayload('subsidy_quote', result)
      } catch (error) {
        return { ...textContent(stringifyError(error)), isError: true }
      }
    }
  )

  server.registerTool(
    'subsidy_buckets',
    {
      title: 'Subsidy: budget buckets & remaining',
      description:
        'Reads a subsidy provider budget for a payer + token (SubsidyView, read-only): the per-window ' +
        'buckets (limit/used/remaining; check `unlimited` first) via subsidyBuckets and the overall ' +
        'remainingSubsidy. Amounts are in human-readable token units. NOTE: `remaining` is additionally ' +
        'gated to 0 by several independent gates — the per-token config (paused, token disabled, or ' +
        'pctBps == 0) AND the payer allow-list — so it can legitimately be 0 while the per-window ' +
        '`buckets` still show headroom. To diagnose, call subsidy_get_info with `token` (its ' +
        '`tokenConfig` shows the paused/disabled/pctBps gates) and with `payer` (inspect the returned ' +
        '`isUserAllowed` for the allow-list gate). `tokenConfig` alone does not reveal the ' +
        'payer-specific allow-list result or identify every applicable gate.',
      inputSchema: {
        ...contractInputSchema,
        payer: z.string().describe('Payer address.'),
        token: z.string().describe('Payment token address.'),
        tokenDecimals: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Optional token decimals override.')
      }
    },
    async ({ chainId, contractAddress, payer, token, tokenDecimals }) => {
      try {
        const view = getSubsidyView(evmRegistry, chainId, contractAddress)
        const [buckets, remaining] = await Promise.all([
          view.subsidyBuckets(getAddress(payer), getAddress(token), tokenDecimals),
          view.remainingSubsidy(getAddress(payer), getAddress(token), tokenDecimals)
        ])
        return commandResultPayload('subsidy_buckets', { buckets, remaining })
      } catch (error) {
        return { ...textContent(stringifyError(error)), isError: true }
      }
    }
  )
}
