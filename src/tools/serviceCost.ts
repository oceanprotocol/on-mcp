import { parseUnits } from 'ethers'
import type {
  ComputeEnvironment,
  ComputeResource,
  ComputeResourceRequest,
  ServiceJob,
  ServiceTemplatePublic,
  TemplateResourceRequirement,
  UserConfigurableEnvVar
} from '@oceanprotocol/lib'

import { serviceMinLockSeconds, type PaymentInfo } from './escrowPreflight.js'
import { isServiceTerminal, serviceStatusLabel } from './serviceSchemas.js'

/**
 * Pure, network-free helpers for the Service-on-Demand tools — ported from ocean-cli's
 * `src/serviceHelpers.ts`, with the divergences from ocean-node's own arithmetic corrected
 * (see `estimateServiceCost`). No MCP or I/O dependencies, so all of this is unit-testable.
 */

/** A resource requirement expressed either by exact id or by kind/type. */
export type ResourceRequirement = TemplateResourceRequirement

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
  return (reqs ?? []).every((req) => availableFor(env, req) >= req.min)
}

/** Human-readable reason a resource set does not fit an env, or null when it fits. */
export function resourceShortfallReason(
  env: ComputeEnvironment,
  reqs?: ResourceRequirement[]
): string | null {
  for (const req of reqs ?? []) {
    const have = availableFor(env, req)
    if (have < req.min) {
      const what = req.id ?? `${req.kind ?? 'resource'}${req.type ? `/${req.type}` : ''}`
      return `${what}: need ${req.min}, have ${have}`
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

export type ServiceCostEstimate = {
  /** Cost in human token units, computed with the node's own arithmetic. */
  costHuman: number
  /** `feeToken` **verbatim as the env advertised it** — send this back, not the caller's casing. */
  feeToken: string
  /** Duration after the `env.minJobDuration` floor clamp. */
  effectiveDurationSeconds: number
  /** `ceil(effectiveDuration / 60)` — what the node actually bills. */
  minutesBilled: number
  resources: ComputeResourceRequest[]
  /** Resource ids the env has no price for; the node prices these at 0 silently. */
  unpricedResourceIds: string[]
}

/**
 * Reimplementation of ocean-node's `C2DEngine.calculateResourcesCost` — there is no
 * server-side quote command for services, so cost has to be derived client-side.
 *
 * Two corrections vs ocean-cli's estimator, both of which caused **under**-estimation:
 *  1. the `env.minJobDuration` floor clamp (`compute_engine_base.ts:943`) is applied here too;
 *  2. `feeToken` is matched case-insensitively for *searching*, but the env's own spelling is
 *     returned in `feeToken` — the node compares with `===`, so a re-cased copy of the user's
 *     input would pass our check and then fail at the node with `400 No pricing configured`.
 *
 * Returns null when the env advertises no fee schedule for `(chainId, token)`.
 */
export function estimateServiceCost(
  env: ComputeEnvironment,
  chainId: number,
  token: string,
  resources: ComputeResourceRequest[],
  durationSeconds: number
): ServiceCostEstimate | null {
  const schedules = env.fees?.[String(chainId)]
  const schedule = schedules?.find(
    (f) => f.feeToken?.toLowerCase() === token.toLowerCase()
  )
  if (!schedule) return null

  const effectiveDurationSeconds = Math.max(durationSeconds, env.minJobDuration ?? 0)
  const minutesBilled = Math.ceil(effectiveDurationSeconds / 60)

  const unpricedResourceIds: string[] = []
  let costHuman = 0
  for (const request of resources) {
    const entry = schedule.prices?.find((p) => p.id === request.id)
    // ocean-node's getResourcePrice() returns 0 for an unknown id, silently — mirror that,
    // but tell the caller which ids were free so a typo does not read as a bargain.
    if (!entry) unpricedResourceIds.push(request.id)
    costHuman += Number(entry?.price ?? 0) * request.amount * minutesBilled
  }

  return {
    costHuman,
    feeToken: schedule.feeToken,
    effectiveDurationSeconds,
    minutesBilled,
    resources,
    unpricedResourceIds
  }
}

/**
 * Float64 → plain decimal string with the binary-representation noise stripped.
 *
 * `toFixed(18)` is not usable here: it prints the *exact* binary value, so `123.456` becomes
 * `123.456000000000003070` and that error lands in the raw token amount. `toPrecision(15)` stays
 * inside float64's reliable significant-digit range, but emits exponent notation for very small
 * or very large values, which `parseUnits` rejects — so expand it by hand.
 */
function toPlainDecimalString(value: number, significantDigits = 15): string {
  const s = value.toPrecision(significantDigits)
  if (!/e/i.test(s)) return s

  const [mantissa, expPart] = s.split(/e/i)
  const exponent = Number(expPart)
  const negative = mantissa.startsWith('-')
  const [intPart, fracPart = ''] = mantissa.replace('-', '').split('.')
  const digits = intPart + fracPart
  const pointPosition = intPart.length + exponent

  let plain: string
  if (pointPosition <= 0) {
    plain = `0.${'0'.repeat(-pointPosition)}${digits}`
  } else if (pointPosition >= digits.length) {
    plain = digits + '0'.repeat(pointPosition - digits.length)
  } else {
    plain = `${digits.slice(0, pointPosition)}.${digits.slice(pointPosition)}`
  }
  return negative ? `-${plain}` : plain
}

/**
 * Human token amount → raw base units as a **decimal string**. Never a JS number: an
 * 18-decimal amount is ~1e20 and would silently lose precision past Number.MAX_SAFE_INTEGER.
 *
 * When the value has more fraction digits than the token has decimals, the remainder is rounded
 * **up** by one base unit. Sub-wei rounding is economically irrelevant either way, but an
 * estimate that rounds down feeds a too-small authorization into `escrow_preflight`, and
 * under-authorizing is the failure this whole path is built to avoid.
 */
export function toRawAmount(costHuman: number, decimals: number): string {
  if (!Number.isFinite(costHuman) || costHuman < 0) {
    throw new Error(`Cannot convert cost ${costHuman} to raw token units`)
  }
  const plain = toPlainDecimalString(costHuman)
  const [intPart, fracPart = ''] = plain.split('.')
  const kept = fracPart.slice(0, decimals)
  const dropped = fracPart.slice(decimals)

  let raw = parseUnits(`${intPart}.${kept || '0'}`, decimals)
  if (/[1-9]/.test(dropped)) raw += 1n
  return raw.toString()
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
 * Add the fields an agent needs but the node does not send: a status label that covers `45`,
 * an ISO expiry, whether polling should stop, and whether the start payment was claimed (a
 * precondition for restart).
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

  return {
    ...(job as unknown as Record<string, unknown>),
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
  const resources = (template.requiredResources ?? [])
    .filter((r) => typeof r.id === 'string')
    .map((r) => ({ id: r.id as string, amount: r.min }))

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
    ...(resources.length ? { resources } : {})
  }

  const notes: string[] = [
    "serviceStartArgs is already renamed to serviceStart's schema: template.command → dockerCmd, template.entrypoint → dockerEntrypoint. Passing `command`/`entrypoint` to serviceStart silently does nothing.",
    'Still to add yourself: `environment`, `duration`, `payment{chainId,token}`, and `userData` for the userDataKeys below.'
  ]
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
