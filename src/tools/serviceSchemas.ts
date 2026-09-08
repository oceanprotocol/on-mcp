import { z } from 'zod/v4'
import { PROTOCOL_COMMANDS } from '@oceanprotocol/lib'

/**
 * Shared schema fragments and long-form guides for the Service-on-Demand tool family.
 * Sibling of `p2pSchemas.ts`; the guides are the actual UX in MCP, so they carry the
 * behaviour an agent cannot infer from the JSON schema alone.
 */

/**
 * Human-readable status labels for `ServiceStatusNumber`.
 *
 * These are deliberately **not** the enum's identifiers: an agent reporting to a user wants
 * "Image pull FAILED", not `PullImageFailed`. Keep this map as the naming source rather than a
 * `ServiceStatusNumber[n]` reverse lookup, which also degrades to `undefined` whenever the node
 * emits a code the shipped enum lags on — `45 Restarting` was exactly that case until
 * `@oceanprotocol/lib@9.0.0-next.8` added it. `serviceStatusLabels.test.ts` asserts this map
 * covers every enum member, so upstream additions surface as a test failure, not an `undefined`.
 */
export const SERVICE_STATUS_LABELS: Record<number, string> = {
  10: 'Starting',
  11: 'Pulling image',
  12: 'Image pull FAILED',
  13: 'Building image',
  14: 'Image build FAILED',
  15: 'Image VULNERABLE',
  20: 'Locking escrow',
  30: 'Claiming payment',
  40: 'Running',
  45: 'Restarting',
  50: 'Stopping',
  70: 'Stopped',
  75: 'Expired',
  99: 'Error'
}

/** Statuses that mean the service failed and will never reach Running on its own. */
export const TERMINAL_FAILURE_STATUSES = [12, 14, 15, 99]

/** Benign end states. `Stopping (50)` is deliberately NOT here — see `isServiceTerminal`. */
export const SERVICE_END_STATUSES = [70, 75]

/**
 * True when a poller should stop. `Stopping (50)` is **in flight, not terminal**: ocean-node
 * counts it among `getRunningServiceJobs`' active statuses (`sqliteCompute.ts:350`), it still
 * holds its cpu/ram/gpu and host ports, and ocean-cli's own `isTerminal()` excludes it. A
 * poller that halts at `50` reports "done" while teardown is still running — keep polling to `70`.
 */
export function isServiceTerminal(status: number): boolean {
  return (
    TERMINAL_FAILURE_STATUSES.includes(status) || SERVICE_END_STATUSES.includes(status)
  )
}

/** Prefer the node-provided `statusText`; fall back to the local label map. */
export function serviceStatusLabel(status: number, statusText?: string): string {
  return statusText || SERVICE_STATUS_LABELS[status] || `status ${status}`
}

export const SERVICE_OVERVIEW_GUIDE = `## What a "service" is (and why it is not a compute job)
A service is a **long-running container** the consumer launches on a compute environment and pays for **up front via escrow**. Unlike a compute job it does not run to completion — it stays up for the requested \`duration\` and **exposes network endpoints** (\`http://<nodeHost>:<hostPort>\`) that the consumer connects to while it runs. The caller supplies the container spec directly (image + one of \`tag\`/\`checksum\`/\`dockerfile\`, ports, resources, duration, and \`userData\` injected as container env vars).

- **Start is asynchronous.** \`serviceStart\` validates, persists a \`Starting (10)\` record and returns a \`serviceId\` immediately. A background loop then runs escrow \`createLock\` → image pull/build + vulnerability scan → \`claimLock\` (or \`cancelLock\` refund if the image step failed) → port allocation → container start → \`Running (40)\`. **You must poll \`serviceStatus\`.** Restart is asynchronous too (\`Restarting (45)\`).
- **There is no server-side quote.** Compute has \`initializeCompute\`; services have no equivalent command. The node computes cost itself at \`${PROTOCOL_COMMANDS.SERVICE_START}\`. Any client-side figure — including \`estimateServiceCost\` — is an **estimate**.
- **The resource reservation lasts the whole paid window.** \`serviceStop\` tears down the container but **keeps** cpu/ram/gpu and host ports reserved until \`expiresAt\`; only \`Expired (75)\` releases them. \`Error (99)\` also still holds the reservation (and is restartable). Stopping early does **not** refund or save money.
- **Endpoints are not authenticated by the node** — it only port-forwards. Anyone who learns the URL can reach the container. Put your own auth in front of anything sensitive.
- **In-container ports must be ≥ 1024.** The container runs with \`CapDrop: ['ALL']\`, which removes \`NET_BIND_SERVICE\`, so a process trying to bind :80 will fail.
- **\`getServices\` is node-wide**, not owner-scoped — you will see other consumers' services. \`serviceStatus\` and \`serviceLogs\` **are** owner-scoped.
- **Access lists are re-checked on start, extend and restart — but not stop.** A consumer removed from an env's allow-list can no longer start/extend/restart, but can still shut their own service down.`

export const SERVICE_POLLING_GUIDE = `## After starting: poll to Running — do NOT ask the user between polls
\`serviceStart\` / \`serviceRestart\` return immediately with a \`serviceId\`. Call **serviceStatus** every ~5–10s until the status settles, then report the endpoint URLs. An image pull or build can take **minutes**; do not ask "shall I check again?" after every tick — just keep polling.

| Status | Meaning | Action |
|---|---|---|
| 10 Starting · 11 Pulling image · 13 Building image · 20 Locking escrow · 30 Claiming payment · 45 Restarting | in flight | keep polling |
| **40 Running** | up | report \`endpoints[].url\` |
| **50 Stopping** | teardown in flight, **NOT an end state** | keep polling to 70 |
| 70 Stopped · 75 Expired | end states | stop polling |
| 12 Image pull FAILED · 14 Image build FAILED · 15 Image VULNERABLE · 99 Error | terminal failure | stop and report the reason |

\`Error (99)\` and the two end states differ in money terms: an \`Error\` service still **holds its reservation** and can be restarted; only \`Expired (75)\` releases it.`

export const SERVICE_PAYMENT_GUIDE = `## Paying for a service — there is no server-side quote
1. **findServiceEnvironments** → pick an env advertised as service-capable that has a fee schedule for your \`(chainId, token)\` and free capacity.
2. **estimateServiceCost** with the env, \`duration\`, \`chainId\`, \`token\` and \`resources\` → returns a cost **estimate** plus a ready-to-use \`payment\` object.
3. **escrow_preflight** with that \`payment\` and \`maxJobDuration = duration\` → checks escrow funds + the node authorization; with a \`privateKey\` it deposits and authorizes for you, otherwise it returns a Manage-escrow redirect.
4. **serviceStart**. It re-runs the same gate and refuses to start when escrow cannot back the service (bypass with \`skipEscrowPreflight: true\`).

**Caveats that make the estimate an estimate, not a promise:**
- The node applies an \`env.minServiceDuration\` **floor**: a 30s service on an env with \`minServiceDuration: 60\` is billed for 60s. \`estimateServiceCost\` applies the same clamp — \`minutesBilled\` may exceed your requested duration.
- The node matches \`feeToken\` **exactly and case-sensitively**. \`estimateServiceCost\` searches case-insensitively but echoes \`payment.token\` back **verbatim as the env advertised it** — send that value through unchanged, never a re-cased copy.
- An unknown resource id is silently priced at **0** by the node, so a typo'd resource looks free.
- \`payment.minLockSeconds\` is a **padded estimate**: the node's rule is \`duration + claimDurationTimeout\`, and \`claimDurationTimeout\` is per-node config (default 3600s) that **no protocol command exposes**. On a node that raised it, a lock can still fail after this check passes.
- The service duration cap is \`env.maxServiceDuration\` (**advertised** on the env; \`serviceStart\` rejects an over-long \`duration\` client-side). A stricter \`serviceOnDemand.maxDurationSeconds\` node-config cap (default 86400s) may still apply and is **not advertised** — if so, an over-long \`duration\` fails at start with a \`400\`.

**Never self-denominate raw amounts.** Call \`get_erc20_token_info(chainId, token, rawAmount)\` and show \`<formatted> <symbol>\` before telling the user a price.`

export const SERVICE_RESTART_SEMANTICS_GUIDE = `## Restart is atomic: REUSE or RESPEC — never a partial change
- **REUSE** — send **no** container params. The service restarts on its **stored** spec (same image, cmd, entrypoint, userData). This is the "just bounce it" path.
- **RESPEC** — send **any** of \`image\`, \`tag\`, \`checksum\`, \`dockerfile\`, \`additionalDockerFiles\`, \`dockerCmd\`, \`dockerEntrypoint\`, \`userData\`. The container is then rebuilt **entirely from this request**: \`image\` becomes **mandatory**, and anything you omit is **empty, not inherited**.

A lone new \`dockerCmd\` or \`userData\` is therefore rejected by the node with a \`400\` ("restart is all-old or all-new"). This tool catches that locally before the round-trip.

**Recipe — rotate a secret in \`userData\`** (e.g. a leaked API key). There is no "change only userData" call; do a RESPEC restart that **re-sends the same image + tag** alongside the new \`userData\`:
\`\`\`jsonc
{ "serviceId": "…",
  "image": "vllm/vllm-openai",   // ← re-send the SAME image
  "tag": "v0.6.2",               // ← and the SAME tag
  "dockerCmd": ["--model","Qwen/Qwen2-0.5B"],  // ← re-send anything you still want
  "userData": { "HF_TOKEN": "<new token>" } }
\`\`\`
Read the current spec off \`serviceStatus\` first (it returns \`image\`/\`tag\`/\`dockerCmd\`/\`dockerEntrypoint\` — but **never** \`userData\`, which the node always strips, so you must re-supply every key you want the container to keep).

Restart is **free** (no new escrow lock) but needs a **claimed** start payment: a service whose start payment was never claimed cannot be restarted — start a new one. An \`Expired (75)\` service cannot be restarted either.`

export const SERVICE_USERDATA_GUIDE = `## userData — plaintext in, keys only out
Pass \`userData\` as a **plain JSON object** of env-var name → value. ocean.js ECIES-encrypts it to the node's public key before it leaves this server; **never** pass a pre-encrypted string.

- Values become container **environment variables**, and \`\${KEY}\` placeholders in \`dockerCmd\`/\`dockerEntrypoint\` are expanded from them.
- ⚠️ **Secrets in \`userData\` transit the chat/LLM context.** Prefer short-lived, narrowly-scoped tokens. Tool responses echo **keys only, never values**, and the node strips \`userData\` from every response — so after start there is no way to read a value back.
- Validate against the template's \`userConfigurableEnvVars\`: keys not listed there are a **warning**, not an error (a template is a suggestion, not an allow-list), but a \`validation\` regex that fails is an error. The failing **value is never printed**.
- \`envVarKeys\` on a template are the **operator's** env vars — keys are exposed, values never are. Do **not** send them back in \`userData\`.`

export const SERVICE_AUTH_NOTE = `## Prefer \`authToken\` for services
A service lifecycle is **many signed calls** (start → poll status ×N → extend → restart → stop → logs), and every \`completeSignature\` needs a **fresh \`getNonce() + 1\`**. Two signed calls issued concurrently against the same (node, consumer) pair can reuse a stale nonce and one will be rejected — so if you must use \`completeSignature\`, serialize the calls and never fire a signed poll while another signed request is in flight. An \`authToken\` sidesteps all of this. Tokens are **per-node**; mint one at https://dashboard.oncompute.ai/nodes/tokens (needs the target node peerID) or via \`create_auth_token\`.`

/** Container-spec fields shared by serviceStart and serviceRestart. */
export const serviceContainerSpecSchema = {
  image: z
    .string()
    .optional()
    .describe(
      'Base image name (or a build label when `dockerfile` is set). REQUIRED on serviceStart, and required on serviceRestart as soon as any other container param is present.'
    ),
  tag: z
    .string()
    .optional()
    .describe('Pull by name:tag. Mutually exclusive with `checksum` and `dockerfile`.'),
  checksum: z
    .string()
    .optional()
    .describe(
      'Pull by digest, "sha256:<64 hex>". Mutually exclusive with `tag` and `dockerfile`.'
    ),
  dockerfile: z
    .string()
    .optional()
    .describe(
      "Inline Dockerfile content, built on the operator's Docker daemon — i.e. **arbitrary build execution** on their host. Only works where the env has `allowImageBuild=true`, else 403. Mutually exclusive with `tag`/`checksum`."
    ),
  additionalDockerFiles: z
    .record(z.string(), z.string())
    .optional()
    .describe(
      'filename → content, copied into the build context. Only with `dockerfile`.'
    ),
  dockerCmd: z
    .array(z.string())
    .optional()
    .describe(
      `Exec-form CMD override (no shell). \`\${KEY}\` placeholders are expanded from \`userData\`.`
    ),
  dockerEntrypoint: z
    .array(z.string())
    .optional()
    .describe('Exec-form ENTRYPOINT override (no shell).'),
  userData: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      'Plain JSON object of container env vars; ECIES-encrypted to the node before sending. Values transit the chat/LLM — see the userData guide. Never pass a pre-encrypted string.'
    )
}

export const serviceIdSchema = z
  .string()
  .describe('`serviceId` returned by serviceStart (distinct from a compute `jobId`).')

export const servicePaymentSchema = z
  .object({
    chainId: z.number().int().positive().describe('EVM chain id the escrow lives on.'),
    token: z
      .string()
      .describe(
        'Fee token address. Pass the value **verbatim as the env advertised it** in `fees[chainId][].feeToken` — the node matches case-sensitively.'
      )
  })
  .describe(
    'Payment selector. The node computes the cost itself; there is no quote command.'
  )

export const serviceListFiltersSchema = {
  status: z
    .number()
    .int()
    .optional()
    .describe(
      'Filter to ONE ServiceStatusNumber (incl. 75 Expired). Takes precedence over includeAllStatuses.'
    ),
  includeAllStatuses: z
    .boolean()
    .optional()
    .describe(
      'Return services in EVERY status instead of only the resource-holding set (the default).'
    ),
  fromTimestamp: z
    .string()
    .optional()
    .describe(
      'Only services created at/after this moment: ISO date string, or a Unix timestamp (s or ms) as a string.'
    ),
  updatedSince: z
    .string()
    .optional()
    .describe(
      'Only services created OR status-changed at/after this moment (same formats). Returns every status — this is the incremental-sync cursor; feed back the max `updatedAt` you saw.'
    )
}

/** Resource requests, shared by estimateServiceCost / findServiceEnvironments / serviceStart. */
export const serviceResourcesSchema = z
  .array(
    z.object({
      id: z
        .string()
        .describe(
          'Resource id as advertised by the env (`cpu`, `ram`, `disk`, or a named GPU like `gpu-0`). An id the env does not know is silently priced at 0 by the node.'
        ),
      amount: z.number().describe('Amount of that resource (cores, GB, or count).')
    })
  )
  .optional()
  .describe(
    'Requested resources. Omit to let the node fill cpu/ram/disk defaults (it enforces per-resource minimums, so you may be billed above what you asked for).'
  )
