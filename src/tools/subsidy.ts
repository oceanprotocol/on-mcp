import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
  estimateJobSubsidy,
  isNonEmpty,
  isUnsupportedInterfaceError,
  OneTimeSubsidyProvider,
  OPFSubsidyProvider,
  SubsidyKind,
  SubsidyMode,
  SubsidyModeConfig,
  SubsidyView
} from '@oceanprotocol/lib'
import type {
  ComputeEnvironment,
  JobSubsidyEstimate,
  JobSubsidyScenario
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
import { resourceMinimumWarnings } from './serviceCost.js'

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
 * serviceStart / serviceExtend. `subsidy_recommend` is a thin wrapper over ocean.js
 * `estimateJobSubsidy` — cost, image gate, quoting and selection all live in the library.
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
        'for `isJobTypeSubsidized`. This configured list is what the node uses by default (when a ' +
        'job passes no `subsidyProviders`); a non-empty caller list instead REPLACES it. ' +
        '`subsidyProviderFilter` is also returned and governs caller-supplied addresses: when TRUE ' +
        'they must be within this list (others are rejected), when FALSE the node also honours ' +
        'addresses outside it. Target the node with `nodeId` / `multiaddress`.',
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
      title: 'Subsidy: estimate subsidy & escrow for a job',
      description:
        'Read-only subsidy pre-flight for one job (ocean.js `estimateJobSubsidy`): how much subsidy ' +
        'it gets per provider and per delivery mode, which `subsidyProviders` list to pass to ' +
        'computeStart / serviceStart / serviceExtend, and how much the payer must hold in escrow. ' +
        'Derives the job cost from the env fee schedule (same arithmetic as estimateServiceCost), ' +
        "takes candidates from the node's `status.subsidyProviders[chainId]` plus " +
        '`customSubsidyProviders`, applies the node image gate (`subsidyProviderAllowedImages`: a ' +
        'provider with an allowlist only sponsors a matching image run WITHOUT a custom ' +
        'entrypoint/cmd), checks the node/user/jobType gates and quotes each provider. Returns ' +
        '`scenarios.reimbursement` (subsidy refunded at claim — the payer still fronts the full ' +
        'cost) and `scenarios.prefunded` (lock-time sponsorship — the deposit shrinks by the ' +
        'subsidy; needs an escrow with lock-subsidy support), each with `selected`, ' +
        '`projectedTotalSubsidy`, `escrowNeeded`, `escrowAvailable`, `escrowShortfall`; plus ' +
        '`providers[]` with gate results, both quotes and a `dropped` reason for every candidate ' +
        "left out. Pass a scenario's `selected` VERBATIM as `subsidyProviders` — order is the " +
        'drawdown order, and an empty list means pass `[]` (omitting the argument makes the node ' +
        'fall back to its own set). Amounts are human-readable token units except `costBaseUnits` ' +
        '(raw; the `amount` escrow_preflight expects). Advisory only: the node recomputes cost ' +
        "and the contracts settle at start. `escrowAddress` is the node's own claim — unverified.",
      inputSchema: {
        ...nodeTargetSchema,
        chainId: z.number().int().positive().describe('Payment chain id.'),
        payer: z.string().describe('Payer (consumer) address.'),
        token: z
          .string()
          .describe(
            "Payment token address. The result's `token` echoes the env's own spelling — send that one at start."
          ),
        jobType: z
          .union([z.number().int().nonnegative(), z.string()])
          .describe("Job type: 1 or 'compute', 2 or 'service' (ocean-node numbering)."),
        environment: z.string().describe('Compute environment id on the node.'),
        resources: z
          .array(z.object({ id: z.string(), amount: z.number().nonnegative() }))
          .min(1)
          .describe(
            'Resources to price — the SAME list you will send at start (no defaults are filled in). ' +
              'An id the env does not price counts as 0 and is listed in `unpricedResourceIds`. ' +
              'Amounts below an env per-resource `min` are priced AS GIVEN and flagged in ' +
              '`warnings` — the node bills at its minimum, so cost and escrow figures are then ' +
              'too low; re-run with the minimum.'
          ),
        duration: z
          .number()
          .positive()
          .describe(
            'Job duration in seconds (for serviceExtend: the additional duration). Billed at the ' +
              "env's minimum-duration floor if lower."
          ),
        image: z
          .string()
          .optional()
          .describe(
            'Container image name the job runs (service `image`, or the compute algorithm ' +
              'container image). Needed by the image gate: without it, providers that restrict ' +
              'images are reported as `image_not_allowed`.'
          ),
        tag: z.string().optional().describe('Image tag (default `latest`).'),
        checksum: z
          .string()
          .optional()
          .describe('Image digest ("sha256:…"). Wins over `tag` when both are set.'),
        dockerfile: z
          .string()
          .optional()
          .describe(
            'Inline Dockerfile, if the image is built from one. A user-built image never matches ' +
              'an allowlist. Any non-empty value is enough here.'
          ),
        dockerEntrypoint: z
          .array(z.string())
          .optional()
          .describe(
            'Service ENTRYPOINT override, exactly as you will pass it to serviceStart.'
          ),
        dockerCmd: z
          .array(z.string())
          .optional()
          .describe('Service CMD override, exactly as you will pass it to serviceStart.'),
        hasCustomEntrypoint: z
          .boolean()
          .optional()
          .describe(
            'Set true when the workload is not the plain trusted image. Services: derived for you ' +
              'from `dockerEntrypoint`/`dockerCmd`. COMPUTE: you MUST set it true when the ' +
              'algorithm container overrides the entrypoint OR the algorithm is user-supplied ' +
              '(rawcode, a fileObject, or a documentId/serviceId DID) — the node then refuses ' +
              'image-restricted subsidies, and leaving it false overstates the subsidy.'
          ),
        queueMaxWaitTime: z
          .number()
          .nonnegative()
          .optional()
          .describe(
            "Compute only: the env's queue max wait in seconds. Added to `minLockSeconds`, never to the cost."
          ),
        customSubsidyProviders: z
          .array(z.string())
          .optional()
          .describe(
            "Extra provider addresses to consider on top of the node's advertised set. With " +
              '`subsidyProviderFilter` on, ones outside that set are dropped as `outside_node_set`.'
          ),
        subsidyNeeded: z
          .string()
          .optional()
          .describe(
            'Subsidy to cover, human-readable token units. Default: the full job cost.'
          ),
        tokenDecimals: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Optional token decimals override.')
      }
    },
    async (args) => {
      try {
        const node = parseNodeTarget(args.nodeId, args.multiaddress)
        const ms = timeoutMs(args.timeout)
        // The lib prices `resources` exactly as given, but the node raises each one to the env's
        // advertised `min` before billing. Read the envs alongside so an under-minimum request is
        // flagged with the same warning estimateServiceCost gives, instead of silently producing
        // cost / escrowNeeded figures that are too low. Best-effort: a failed read never masks
        // the estimate (which reads the envs itself and reports the real error).
        const envsPromise = nodeClient
          .getComputeEnvironments<ComputeEnvironment[]>(node, ms)
          .catch((): ComputeEnvironment[] => [])
        const estimate = await estimateJobSubsidy({
          signer: getVoidSigner(evmRegistry, args.chainId) as any,
          chainId: args.chainId,
          payer: args.payer,
          node,
          token: args.token,
          environmentId: args.environment,
          resources: args.resources,
          durationSeconds: args.duration,
          jobType: args.jobType,
          container: {
            image: args.image,
            tag: args.tag,
            checksum: args.checksum,
            dockerfile: args.dockerfile
          },
          // The node's own service predicate; for compute the caller supplies the flag.
          hasCustomEntrypoint:
            args.hasCustomEntrypoint === true ||
            isNonEmpty(args.dockerEntrypoint) ||
            isNonEmpty(args.dockerCmd),
          queueMaxWaitTime: args.queueMaxWaitTime,
          customSubsidyProviders: args.customSubsidyProviders,
          subsidyNeeded: args.subsidyNeeded,
          tokenDecimals: args.tokenDecimals,
          signal: AbortSignal.timeout(ms)
        })
        const env = (await envsPromise).find((e) => e.id === args.environment)
        return commandResultPayload(
          'subsidy_recommend',
          describeSubsidyEstimate(
            estimate,
            env ? resourceMinimumWarnings(env, args.resources) : []
          )
        )
      } catch (error) {
        return { ...textContent(stringifyError(error)), isError: true }
      }
    }
  )
}

/**
 * `estimateJobSubsidy` result as the tool returns it: enum values replaced by their names, and
 * each provider flattened to one compact row (ineligible candidates carry no quotes — they are
 * all zero). `extraWarnings` (on-mcp's own, e.g. under-minimum resources) are listed first.
 * Exported for unit tests.
 */
export function describeSubsidyEstimate(
  estimate: JobSubsidyEstimate,
  extraWarnings: string[] = []
) {
  const scenario = (s: JobSubsidyScenario) => ({
    ...s,
    mode: SubsidyMode[s.mode] ?? String(s.mode)
  })
  return {
    ...estimate,
    warnings: [...extraWarnings, ...estimate.warnings],
    providers: estimate.providers.map((p) => ({
      address: p.address,
      subsidyKind:
        p.subsidyKind === null
          ? null
          : (SubsidyKind[p.subsidyKind] ?? String(p.subsidyKind)),
      version: p.version,
      isV2: p.isV2,
      eligible: p.eligible,
      ...(p.dropped ? { dropped: p.dropped, reason: p.reason } : {}),
      gates: p.gates,
      ...(p.eligible ? { quotes: p.quotes } : {})
    })),
    scenarios: {
      reimbursement: scenario(estimate.scenarios.reimbursement),
      prefunded: scenario(estimate.scenarios.prefunded)
    }
  }
}
