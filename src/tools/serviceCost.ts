import { gzipSync } from 'node:zlib'
import { serviceMinLockSeconds } from '@oceanprotocol/lib'
import type {
  ComputeEnvironment,
  ComputeResource,
  ComputeResourceRequest,
  ServiceJob,
  ServiceTemplatePublic,
  UserConfigurableEnvVar
} from '@oceanprotocol/lib'

import type { PaymentInfo } from './escrowPreflight.js'
import { isServiceTerminal, serviceStatusLabel } from './serviceSchemas.js'

/**
 * Pure, network-free helpers for the Service-on-Demand tools. No MCP or I/O dependencies, so
 * all of this is unit-testable.
 *
 * The cost arithmetic itself (`estimateServiceCost`, `toRawAmount`, `serviceMinLockSeconds`)
 * lives in `@oceanprotocol/lib` (>= 10.1.0) — import it from there, do not reimplement it here.
 */

/**
 * A capacity requirement the fit checks consume: an `amount` to satisfy, selected either by exact
 * resource `id` (cpu/ram/disk) or by `kind`/`type` (e.g. a gpu). This is the on-mcp-internal shape
 * (built from a user's `ComputeResourceRequest` or a template's `recommendedResources`); it is NOT
 * the library's authoring-time `TemplateResourceRequirement` union, which keys amounts on
 * `recommended` and splits gpu out under `kind: 'discrete'` / `type: 'gpu'`.
 */
export interface ResourceRequirement {
  id?: string
  kind?: string
  type?: string
  amount: number
}

/**
 * Free capacity for one requirement: `total - inUse` for an exact id, or summed across every
 * resource of the requested kind (optionally narrowed by type).
 */
export function availableFor(env: ComputeEnvironment, req: ResourceRequirement): number {
  const resources: ComputeResource[] = env.resources ?? []
  if (req.id) {
    const r = resources.find((x) => x.id === req.id)
    return r ? (r.total ?? 0) - (r.inUse ?? 0) : 0
  }
  return resources
    .filter((x) => x.kind === req.kind && (!req.type || x.type === req.type))
    .reduce((sum, x) => sum + ((x.total ?? 0) - (x.inUse ?? 0)), 0)
}

export function envSatisfiesRequirements(
  env: ComputeEnvironment,
  reqs?: ResourceRequirement[]
): boolean {
  return (reqs ?? []).every((req) => availableFor(env, req) >= req.amount)
}

/** Human-readable reason a resource set does not fit an env, or null when it fits. */
export function resourceShortfallReason(
  env: ComputeEnvironment,
  reqs?: ResourceRequirement[]
): string | null {
  for (const req of reqs ?? []) {
    const have = availableFor(env, req)
    if (have < req.amount) {
      const what = req.id ?? `${req.kind ?? 'resource'}${req.type ? `/${req.type}` : ''}`
      return `${what}: need ${req.amount}, have ${have}`
    }
  }
  return null
}

/**
 * Envs advertised as service-capable that also fit the requested resources. `features.services`
 * defaults to `true` node-side, so the test is the negative one — and it is only an
 * advertisement: the start path is authoritative.
 */
export function findServiceEnvironments(
  envs: ComputeEnvironment[],
  reqs?: ResourceRequirement[]
): ComputeEnvironment[] {
  return (envs ?? []).filter(
    (e) => e.features?.services !== false && envSatisfiesRequirements(e, reqs)
  )
}

/**
 * Warn where the env advertises a per-resource `min` above what was requested. The node runs
 * `checkAndFillMissingResources` and bills at its own minimum, so this is a concrete way our
 * estimate can come in **under** what is actually charged — the failure mode that makes the
 * escrow gate authorize too little and green-light a service the node then rejects.
 */
export function resourceMinimumWarnings(
  env: ComputeEnvironment,
  resources: ComputeResourceRequest[]
): string[] {
  const warnings: string[] = []
  for (const request of resources) {
    const advertised = (env.resources ?? []).find((r) => r.id === request.id)
    if (advertised?.min !== undefined && request.amount < advertised.min) {
      warnings.push(
        `Env "${env.id}" advertises a minimum of ${advertised.min} for "${request.id}" but ` +
          `${request.amount} was requested — the node bills at its minimum, so the real cost ` +
          `will be higher than this estimate.`
      )
    }
  }
  return warnings
}

/** Turn requested amounts into a `ComputeResourceRequest[]`, falling back to cpu/ram = 1. */
export function resolveServiceResources(
  requested: ComputeResourceRequest[] | undefined,
  env: ComputeEnvironment
): ComputeResourceRequest[] {
  if (requested?.length) {
    return requested.map((r) => ({ id: r.id, amount: r.amount }))
  }
  return (env.resources ?? [])
    .filter((r) => r.id === 'cpu' || r.id === 'ram')
    .map((r) => ({ id: r.id, amount: 1 }))
}

export type ServicePaymentBuild =
  | { escrowRequired: true; payment: PaymentInfo; minLockSecondsNote: string }
  | { escrowRequired: false; reason: string }

/**
 * Build the `payment` object `escrow_preflight` already accepts, so services reuse the whole
 * existing escrow surface with no new escrow tool.
 *
 * A **zero** cost is returned as `escrowRequired: false` rather than a payment: preflight's
 * `paymentSchema` is strictly positive on both union branches, so `amount: 0` would fail
 * validation and surface as a confusing schema error instead of "this service is free".
 */
export function buildServicePaymentInfo(params: {
  escrowAddressByChain: Record<string, string> | undefined
  payee: string
  chainId: number
  feeToken: string
  rawAmount: string
  durationSeconds: number
}): ServicePaymentBuild {
  const { escrowAddressByChain, payee, chainId, feeToken, rawAmount, durationSeconds } =
    params

  if (BigInt(rawAmount) === 0n) {
    return {
      escrowRequired: false,
      reason:
        'Estimated cost is 0 (the env prices these resources at 0, or none of the requested ' +
        'resource ids are priced). No escrow lock is needed — skip escrow_preflight. Double-check ' +
        'the resource ids against the env: an unknown id is silently priced at 0 by the node.'
    }
  }

  const escrowAddress = escrowAddressByChain?.[String(chainId)]
  if (!escrowAddress) {
    throw new Error(
      `Node status advertises no escrow address for chainId=${chainId}. ` +
        `Available: ${Object.keys(escrowAddressByChain ?? {}).join(', ') || '(none)'}.`
    )
  }

  const minLockSeconds = serviceMinLockSeconds(durationSeconds)
  return {
    escrowRequired: true,
    payment: {
      escrowAddress,
      chainId,
      payee,
      token: feeToken,
      amount: rawAmount,
      minLockSeconds
    },
    minLockSecondsNote:
      `Padded lower bound. The node's rule is duration + claimDurationTimeout, and ` +
      `claimDurationTimeout is per-node config (default 3600s) that no protocol command ` +
      `exposes — so this assumes the default and pads above it. A createLock can still fail ` +
      `on a node that raised it.`
  }
}

/**
 * Validate `userData` against a template's `userConfigurableEnvVars`. Unlisted keys are a
 * **warning** (a template is a suggestion, not an allow-list); a failing `validation` regex is
 * an error. The offending **value is never included** in the message.
 */
export function parseUserData(
  data: Record<string, unknown> | undefined,
  userConfigurableEnvVars?: UserConfigurableEnvVar[]
): { data?: Record<string, unknown>; warnings: string[] } {
  if (!data) return { warnings: [] }
  if (typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('userData must be a JSON object (not an array or primitive)')
  }

  const warnings: string[] = []
  const byKey = new Map((userConfigurableEnvVars ?? []).map((v) => [v.key, v]))

  for (const key of Object.keys(data)) {
    const spec = byKey.get(key)
    if (!spec) {
      if (userConfigurableEnvVars?.length) {
        warnings.push(
          `userData key "${key}" is not listed in the template's userConfigurableEnvVars — ` +
            `sent anyway (templates are suggestions, not allow-lists).`
        )
      }
      continue
    }
    if (!spec.validation) continue
    let re: RegExp | undefined
    try {
      re = new RegExp(spec.validation)
    } catch {
      warnings.push(
        `Template validation pattern for "${key}" is not a valid regex — skipped.`
      )
      continue
    }
    const value = data[key]
    if (typeof value === 'string' && !re.test(value)) {
      throw new Error(
        `userData value for "${key}" does not match the template's validation pattern ` +
          `(${spec.validation}). The value is not shown.`
      )
    }
  }

  return { data, warnings }
}

/** Safe echo of userData: keys only, never values (they may be secrets). */
export function describeUserDataKeys(data?: Record<string, unknown>): string[] {
  return data ? Object.keys(data) : []
}

export type DecoratedServiceJob = Record<string, unknown> & {
  statusLabel: string
  isTerminal: boolean
  expiresAtIso: string | null
  paymentClaimed: boolean
  userDataKeys?: string[]
  warnings?: string[]
}

/**
 * Node-provided `ServiceJob` fields an agent actually uses, projected onto the response. This
 * replaces a blanket `...job` spread, which echoed low-value plumbing (`clusterHash`,
 * `containerId`, `networkId`, `containerImage`) and the raw `expiresAt` that `expiresAtIso`
 * already supersedes, on every service in every list. Fields absent on a given job (e.g. the
 * sanitized `getServices` listing omits `dockerCmd`/`dockerEntrypoint`) are simply skipped.
 */
const DECORATED_JOB_FIELDS = [
  'serviceId',
  'environment',
  'owner',
  'image',
  'tag',
  'checksum',
  'dockerfile',
  'additionalDockerFiles',
  'dockerCmd',
  'dockerEntrypoint',
  'status',
  'statusText',
  'dateCreated',
  'updatedAt',
  'duration',
  'exposedPorts',
  'endpoints',
  'resources',
  'payment',
  'extendPayments',
  'runtimeMetrics',
  'metadata'
] as const

/**
 * Add the fields an agent needs but the node does not send: a status label that covers `45`,
 * an ISO expiry, whether polling should stop, and whether the start payment was claimed (a
 * precondition for restart). Projects the node job onto a whitelist (see `DECORATED_JOB_FIELDS`)
 * rather than spreading it wholesale, to keep per-call payloads small.
 */
export function decorateServiceJob(job: ServiceJob): DecoratedServiceJob {
  const warnings: string[] = []
  if (job.status === 50) {
    warnings.push(
      'Stopping (50) is still in flight, not an end state — it keeps holding cpu/ram/gpu and ' +
        'host ports. Keep polling until 70 (Stopped).'
    )
  }
  if (job.status === 99) {
    warnings.push(
      'Error (99) still holds the paid resource reservation and is restartable — only Expired ' +
        '(75) releases it. Stopping does not refund.'
    )
  }

  const src = job as unknown as Record<string, unknown>
  const picked: Record<string, unknown> = {}
  for (const key of DECORATED_JOB_FIELDS) {
    if (src[key] !== undefined) picked[key] = src[key]
  }

  return {
    ...picked,
    statusLabel: serviceStatusLabel(job.status, job.statusText),
    isTerminal: isServiceTerminal(job.status),
    expiresAtIso:
      typeof job.expiresAt === 'number' && job.expiresAt > 0
        ? new Date(job.expiresAt).toISOString()
        : null,
    paymentClaimed: Boolean(job.payment?.claimTx),
    ...(warnings.length ? { warnings } : {})
  }
}

/**
 * The `userData` a ComfyUI template needs to install its workflows — mirrors nodes-dashboard's
 * `withWorkflowUserData`. The node inlines each workflow's graph in the template; the bootstrap
 * reads `COMFY_WORKFLOW` (gzip+base64 of `{ "<id>": <graph>, ... }`) and `COMFY_WORKFLOW_ID` (the
 * workflow to open), creates `custom_nodes/<id>` and downloads the models the graphs list.
 * Without them ComfyUI crashes at startup (`/tmp/comfy/custom_nodes` is never created) and no
 * weights download, yet the service still starts and is billed.
 *
 * Workflows with no graph are skipped. Returns `undefined` when none has one (a node that served
 * metadata without bodies), so the literal string "undefined" is never installed as a workflow.
 */
export function buildWorkflowUserData(
  workflows: ServiceTemplatePublic['workflows']
): Record<string, string> | undefined {
  const graphs: Record<string, unknown> = {}
  for (const workflow of workflows ?? []) {
    if (workflow.graph != null) graphs[workflow.id] = workflow.graph
  }
  const [firstId] = Object.keys(graphs)
  if (firstId === undefined) return undefined
  return {
    COMFY_WORKFLOW_ID: firstId,
    COMFY_WORKFLOW: gzipSync(JSON.stringify(graphs)).toString('base64')
  }
}

/**
 * Paste-ready projection of a template into `serviceStart` arguments.
 *
 * This exists to neutralise a field-rename trap: a template's `command`/`entrypoint` are **not**
 * valid `serviceStart` arguments (they are `dockerCmd`/`dockerEntrypoint` there). Copied
 * verbatim they are silently dropped and the container runs its image default. Since templates
 * are informational — there is no `templateId` on `serviceStart`, so the caller hand-copies
 * these fields — the mapping has to be emitted here rather than absorbed by a handler.
 */
export function templateToServiceStartArgs(template: ServiceTemplatePublic): {
  template: ServiceTemplatePublic
  serviceStartArgs: Record<string, unknown>
  userDataKeys: string[]
  operatorEnvVarKeys: string[]
  notes: string[]
} {
  const resources = (template.recommendedResources ?? [])
    .filter((r): r is Extract<typeof r, { id: string }> => 'id' in r)
    .map((r) => ({ id: r.id, amount: r.recommended }))

  const workflowUserData = buildWorkflowUserData(template.workflows)

  const serviceStartArgs: Record<string, unknown> = {
    image: template.image,
    ...(template.tag ? { tag: template.tag } : {}),
    ...(template.checksum ? { checksum: template.checksum } : {}),
    ...(template.dockerfile ? { dockerfile: template.dockerfile } : {}),
    ...(template.additionalDockerFiles
      ? { additionalDockerFiles: template.additionalDockerFiles }
      : {}),
    ...(template.exposedPorts?.length ? { exposedPorts: template.exposedPorts } : {}),
    // ← the rename: template.command / .entrypoint
    ...(template.command ? { dockerCmd: template.command } : {}),
    ...(template.entrypoint ? { dockerEntrypoint: template.entrypoint } : {}),
    ...(resources.length ? { resources } : {}),
    ...(workflowUserData ? { userData: workflowUserData } : {})
  }

  const notes: string[] = [
    "serviceStartArgs is already renamed to serviceStart's schema: template.command → dockerCmd, template.entrypoint → dockerEntrypoint. Passing `command`/`entrypoint` to serviceStart silently does nothing.",
    'Still to add yourself: `environment`, `duration`, `payment{chainId,token}`, and `userData` for the userDataKeys below.'
  ]
  if (workflowUserData) {
    notes.push(
      'serviceStartArgs.userData already holds COMFY_WORKFLOW_ID and COMFY_WORKFLOW (the template workflows, gzip+base64). Keep both and ADD the userDataKeys below to that same object. Without them the bootstrap never installs the workflows or downloads the models, and ComfyUI crashes at startup while the service is still billed.'
    )
  } else if (template.workflows?.length) {
    notes.push(
      'This template lists workflows but the node sent none with a graph, so COMFY_WORKFLOW_ID / COMFY_WORKFLOW cannot be built. A ComfyUI template started without them crashes at startup while still billed — do not start it.'
    )
  }
  const lowPorts = (template.exposedPorts ?? []).filter((p) => p < 1024)
  if (lowPorts.length) {
    notes.push(
      `Template exposes in-container port(s) ${lowPorts.join(', ')} below 1024 — the container runs with CapDrop ALL (no NET_BIND_SERVICE) and cannot bind those.`
    )
  }
  if (template.dockerfile) {
    notes.push(
      'This template builds from a Dockerfile — it only works on an env with allowImageBuild=true (else 403).'
    )
  }

  return {
    template,
    serviceStartArgs,
    userDataKeys: (template.userConfigurableEnvVars ?? []).map((v) => v.key),
    operatorEnvVarKeys: template.envVarKeys ?? [],
    notes
  }
}
