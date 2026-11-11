import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
  EscrowContract,
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

import type { NodeClient } from '../clients/nodeClient.js'
import type { EvmProviderRegistry } from '../evm/evmProviderRegistry.js'
import { stringifyError, textContent } from '../utils/format.js'
import {
  commandResultPayload,
  contractInputSchema,
  getVoidSigner
} from './evmToolUtils.js'
import { nodeTargetSchema, parseNodeTarget, timeoutMs } from './p2pSchemas.js'

type Params = {
  server: McpServer
  evmRegistry: EvmProviderRegistry
}

type NodeParams = Params & {
  nodeClient: NodeClient
}

/** The subsidy-relevant slice of an ocean-node `status` response (see `statusHandler.ts`). */
type NodeSubsidyStatus = {
  /** The node's own (payee) address — the `node` argument the subsidy gates check. */
  address?: string
  /** Per-chain subsidy provider contract addresses this node has configured. */
  subsidyProviders?: Record<string, string[]>
  /** When true, the node ONLY honours providers in `subsidyProviders`; when false it may also
   * resolve others live at claim time, so the list is a floor, not a ceiling. */
  subsidyProviderFilter?: boolean
  /** Per-chain escrow address — used to read the authoritative `maxSponsorsPerLock` cap. */
  escrowAddress?: Record<string, string>
}

/** Default per-lock sponsor cap the v2 escrow enforces, used when the escrow can't be read. */
const DEFAULT_MAX_SPONSORS_PER_LOCK = 10

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
        'Reads a subsidy provider budget for a payer + token (SubsidyView, read-only). Returns ' +
        '`buckets` (a SubsidyBucketReport: top-level `paused`/`userAllowed`/`tokenEnabled` flags plus ' +
        "a per-window `buckets[]` of limit/used/remaining — check each window's `unlimited` first) and " +
        'the overall `remainingSubsidy`. Amounts are in human-readable token units. NOTE: `remaining` ' +
        'is gated to 0 by several independent gates — the provider being `paused`, the token disabled ' +
        'or `pctBps == 0` (per-token config), AND the payer allow-list — so it can legitimately be 0 ' +
        'while the per-window `buckets` still show headroom. Diagnose directly from this result: ' +
        '`buckets.paused` (pause), `buckets.tokenEnabled` (token disabled), `buckets.userAllowed` ' +
        '(payer allow-list). For the `pctBps` gate call subsidy_get_info with `token` (its ' +
        '`tokenConfig` shows only the disabled and pctBps gates, not pause). For the per-job grant a ' +
        'provider would actually give, use subsidy_quote.',
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

/**
 * Node-aware subsidy discovery tools — these resolve the candidate provider set from a target
 * ocean-node's `status` (its `subsidyProviders` map, the authoritative list the node resolves at
 * `startCompute`/`startService`), then enrich/quote each via `SubsidyView`. They bridge the gap the
 * address-keyed reads above leave: those need you to already know a provider address. Use these to
 * discover what a node supports and to pick the `subsidyProviders` list for computeStart /
 * serviceStart / serviceExtend.
 */
export function registerNodeSubsidyTools({
  server,
  evmRegistry,
  nodeClient
}: NodeParams): void {
  server.registerTool(
    'subsidy_list_for_node',
    {
      title: 'Subsidy: providers a node supports',
      description:
        'Lists the subsidy providers a target ocean-node supports on a chain, read from the ' +
        "node's `status` (`subsidyProviders[chainId]`) and enriched per provider via SubsidyView " +
        '(read-only): `subsidyKind`, `version`, capability flags (isSubsidyView, ' +
        'isSubsidyLockProvider), `allowedJobTypes`, and `isNodeAllowed` for this node. Pass ' +
        '`token` for `availableBalance`, `payer` for `isUserAllowed`/`remainingSubsidy`, `jobType` ' +
        'for `isJobTypeSubsidized`. `subsidyProviderFilter` is also returned: when FALSE the node ' +
        'may additionally honour providers resolved live at claim time (the list is a floor); when ' +
        'TRUE only the listed providers are accepted. Target the node with `nodeId` / `multiaddress`.',
      inputSchema: {
        ...nodeTargetSchema,
        chainId: z
          .number()
          .int()
          .positive()
          .describe(
            'Payment chain id whose providers to list (keys the node `subsidyProviders`).'
          ),
        token: z
          .string()
          .optional()
          .describe('Optional token to read each provider `availableBalance` for.'),
        payer: z
          .string()
          .optional()
          .describe(
            'Optional payer address to check isUserAllowed and remainingSubsidy.'
          ),
        jobType: z
          .union([z.number().int().nonnegative(), z.string()])
          .optional()
          .describe(
            'Optional job type to check isJobTypeSubsidized (e.g. 1=COMPUTE, 2=SERVICE).'
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
      nodeId,
      multiaddress,
      timeout,
      chainId,
      token,
      payer,
      jobType,
      tokenDecimals
    }) => {
      try {
        const target = parseNodeTarget(nodeId, multiaddress)
        const status = await nodeClient.status<NodeSubsidyStatus>(
          target,
          timeoutMs(timeout)
        )
        const nodeAddress = status.address
        const providers = status.subsidyProviders?.[String(chainId)] ?? []
        const subsidyProviderFilter = status.subsidyProviderFilter ?? false
        const details = await Promise.all(
          providers.map(async (addr) => {
            try {
              const view = getSubsidyView(evmRegistry, chainId, addr)
              const [isSubsidyView, isSubsidyLockProvider] = await Promise.all([
                view.isSubsidyView(),
                view.isSubsidyLockProvider()
              ])
              const kind = await safe(() => view.subsidyKind())
              return {
                address: getAddress(addr),
                subsidyKind: kind === null ? null : (SubsidyKind[kind] ?? String(kind)),
                version: await safe(() => view.version()),
                isSubsidyView,
                isSubsidyLockProvider,
                allowedJobTypes: await safe(() => view.getAllowedJobTypes()),
                isJobTypeSubsidized:
                  jobType !== undefined
                    ? await safe(() => view.isJobTypeSubsidized(jobType))
                    : null,
                isNodeAllowed: nodeAddress
                  ? await safe(() => view.isNodeAllowed(getAddress(nodeAddress)))
                  : null,
                isUserAllowed: payer
                  ? await safe(() => view.isUserAllowed(getAddress(payer)))
                  : null,
                availableBalance: token
                  ? await safe(() =>
                      view.availableBalance(getAddress(token), tokenDecimals)
                    )
                  : null,
                remainingSubsidy:
                  payer && token
                    ? await safe(() =>
                        view.remainingSubsidy(
                          getAddress(payer),
                          getAddress(token),
                          tokenDecimals
                        )
                      )
                    : null
              }
            } catch (error) {
              return { address: addr, error: stringifyError(error) }
            }
          })
        )
        return commandResultPayload('subsidy_list_for_node', {
          chainId,
          node: nodeAddress ?? null,
          subsidyProviderFilter,
          providerCount: providers.length,
          providers: details
        })
      } catch (error) {
        return { ...textContent(stringifyError(error)), isError: true }
      }
    }
  )

  server.registerTool(
    'subsidy_recommend',
    {
      title: 'Subsidy: recommend providers for a job',
      description:
        'Recommends the ordered `subsidyProviders` list to pass to computeStart / serviceStart / ' +
        "serviceExtend for a specific job. Resolves candidates from the node's `status` " +
        '(`subsidyProviders[chainId]`), quotes each via SubsidyView (PREFUNDED/lock-time when the ' +
        'provider implements ISubsidyViewV2, else the v1 claim-time quote), drops providers failing ' +
        'the node/user/jobType gates or quoting 0, then ranks by coverage and greedily fills up to ' +
        '`subsidyNeeded`, capped at the escrow `maxSponsorsPerLock` (10 at v2). Returns ' +
        '`recommended` (addresses, ready to pass as `subsidyProviders`), `projectedTotalSubsidy`, ' +
        '`meetsSubsidyNeeded`, and per-candidate `candidates`. Amounts are in human-readable token ' +
        'units and the totals are approximate (decimal-string sums) — advisory only; the node and ' +
        'escrow are authoritative at start. When `subsidyProviderFilter` is false the node may add ' +
        'its own providers beyond this list.',
      inputSchema: {
        ...nodeTargetSchema,
        chainId: z.number().int().positive().describe('Payment chain id.'),
        payer: z.string().describe('Payer address.'),
        token: z.string().describe('Payment token address.'),
        jobType: z
          .union([z.number().int().nonnegative(), z.string()])
          .describe('Job type (e.g. 1=COMPUTE, 2=SERVICE as ocean-node defines them).'),
        amount: z.string().describe('Gross job cost (human-readable token units).'),
        subsidyNeeded: z
          .string()
          .describe('Subsidy amount to cover (human-readable token units).'),
        maxProviders: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            'Optional cap on how many providers to recommend (never exceeds the escrow cap).'
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
      nodeId,
      multiaddress,
      timeout,
      chainId,
      payer,
      token,
      jobType,
      amount,
      subsidyNeeded,
      maxProviders,
      tokenDecimals
    }) => {
      try {
        const target = parseNodeTarget(nodeId, multiaddress)
        const status = await nodeClient.status<NodeSubsidyStatus>(
          target,
          timeoutMs(timeout)
        )
        const nodeAddress = status.address
        if (!nodeAddress) {
          throw new Error(
            'Node status did not include an `address`; cannot quote subsidies.'
          )
        }
        const providers = status.subsidyProviders?.[String(chainId)] ?? []
        const subsidyProviderFilter = status.subsidyProviderFilter ?? false

        // Authoritative per-lock sponsor cap: read it from the node's escrow when available.
        let cap = DEFAULT_MAX_SPONSORS_PER_LOCK
        const escrowAddress = status.escrowAddress?.[String(chainId)]
        if (escrowAddress) {
          const escrowSigner = getVoidSigner(evmRegistry, chainId) as any
          const escrow = new EscrowContract(
            getAddress(escrowAddress),
            escrowSigner,
            chainId
          )
          const onChainCap = await safe(() => escrow.maxSponsorsPerLock())
          if (typeof onChainCap === 'number' && onChainCap > 0) cap = onChainCap
        }
        if (maxProviders && maxProviders < cap) cap = maxProviders

        const node = getAddress(nodeAddress)
        const payerAddr = getAddress(payer)
        const tokenAddr = getAddress(token)
        const candidates = await Promise.all(
          providers.map(async (addr) => {
            try {
              const view = getSubsidyView(evmRegistry, chainId, addr)
              const [isNodeAllowed, isUserAllowed, isJobTypeSubsidized] =
                await Promise.all([
                  safe(() => view.isNodeAllowed(node)),
                  safe(() => view.isUserAllowed(payerAddr)),
                  safe(() => view.isJobTypeSubsidized(jobType))
                ])
              // A null gate = the provider doesn't expose that check; treat only an explicit
              // false as disqualifying.
              const eligible =
                isNodeAllowed !== false &&
                isUserAllowed !== false &&
                isJobTypeSubsidized !== false
              const kind = await safe(() => view.subsidyKind())
              let mode = 'REIMBURSEMENT'
              let subsidy = '0'
              let bonus = '0'
              if (eligible) {
                const isV2 = await safe(() => view.isSubsidyViewV2())
                const quote = isV2
                  ? await safe(() =>
                      view.quoteSubsidyByMode(
                        node,
                        payerAddr,
                        jobType,
                        tokenAddr,
                        amount,
                        subsidyNeeded,
                        SubsidyMode.PREFUNDED,
                        tokenDecimals
                      )
                    )
                  : await safe(() =>
                      view.quoteSubsidy(
                        node,
                        payerAddr,
                        jobType,
                        tokenAddr,
                        amount,
                        subsidyNeeded,
                        tokenDecimals
                      )
                    )
                if (quote) {
                  subsidy = quote.subsidy
                  bonus = quote.bonus
                  if (isV2) mode = 'PREFUNDED'
                }
              }
              return {
                address: getAddress(addr),
                subsidyKind: kind === null ? null : (SubsidyKind[kind] ?? String(kind)),
                eligible,
                isNodeAllowed,
                isUserAllowed,
                isJobTypeSubsidized,
                mode,
                subsidy,
                bonus
              }
            } catch (error) {
              return {
                address: addr,
                eligible: false,
                error: stringifyError(error),
                subsidy: '0',
                bonus: '0'
              }
            }
          })
        )

        // Rank eligible, positive-coverage providers by subsidy desc; greedily fill until the
        // requested subsidy is met, capped at the escrow's maxSponsorsPerLock.
        const needed = Number(subsidyNeeded)
        const ranked = candidates
          .filter((c) => c.eligible && Number(c.subsidy) > 0)
          .sort((a, b) => Number(b.subsidy) - Number(a.subsidy))
        const recommended: string[] = []
        let total = 0
        for (const candidate of ranked) {
          if (recommended.length >= cap) break
          recommended.push(candidate.address)
          total += Number(candidate.subsidy)
          if (Number.isFinite(needed) && total >= needed) break
        }

        return commandResultPayload('subsidy_recommend', {
          chainId,
          node: nodeAddress,
          subsidyProviderFilter,
          maxSponsorsPerLock: cap,
          subsidyNeeded,
          recommended,
          projectedTotalSubsidy: String(total),
          meetsSubsidyNeeded: Number.isFinite(needed) ? total >= needed : null,
          candidates
        })
      } catch (error) {
        return { ...textContent(stringifyError(error)), isError: true }
      }
    }
  )
}
