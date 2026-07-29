/**
 * Markdown for MCP resource `ocean://docs/service-on-demand`.
 *
 * An agent-oriented distillation of ocean-node `docs/services.md` plus the template-catalogue
 * conventions. Kept as a code constant rather than a synced doc so it is available regardless
 * of whether `npm run sync:docs-content` has run against a post-#1408 ocean-node checkout.
 */
export const SERVICE_ON_DEMAND_MARKDOWN = `## Service-on-Demand — long-running containers on an Ocean node

A **service** is a container an operator's node runs on your behalf for a fixed, pre-paid
window, publishing network endpoints you connect to while it is up. Think "rent me a vLLM
server for 6 hours", not "run this script and give me the output".

### Service vs compute job — the differences that matter

| | Compute job (C2D) | Service |
|---|---|---|
| Lifetime | runs to completion | stays up for \`duration\`, then expires |
| You get back | output files | **endpoint URLs** |
| Quote | \`initializeCompute\` returns an authoritative \`payment\` | **no quote command** — cost is client-estimated, node-enforced |
| Spec source | a published asset / algorithm | **you supply the container spec directly** |
| Start | synchronous enough to trust | **asynchronous** — poll to \`Running\` |

### The 8 protocol commands

| MCP tool | Protocol command | Auth |
|---|---|---|
| \`getServiceTemplates\` | \`serviceGetTemplates\` | **none** |
| \`serviceStart\` | \`serviceStart\` | yes |
| \`serviceStatus\` | \`serviceGetStatus\` | yes, **owner-scoped** |
| \`getServices\` | \`serviceList\` | yes, **node-wide (not owner-scoped)** |
| \`serviceExtend\` | \`serviceExtend\` | yes |
| \`serviceRestart\` | \`serviceRestart\` | yes |
| \`serviceStop\` | \`serviceStop\` | yes, owner-gated |
| \`serviceLogs\` | \`serviceGetStreamableLogs\` | yes, owner-scoped |

Plus three client-side helpers this MCP server adds: \`findServiceEnvironments\`,
\`findServiceNodes\` and \`estimateServiceCost\`.

### Lifecycle and status codes

\`serviceStart\` persists a \`Starting (10)\` record and returns a \`serviceId\` **immediately**.
A background loop then does: escrow \`createLock\` → image pull or build + vulnerability scan →
\`claimLock\` (or \`cancelLock\` refund if the image step failed) → host-port allocation →
container start → \`Running (40)\`.

\`10\` Starting · \`11\` PullImage · \`12\` PullImageFailed · \`13\` BuildImage · \`14\` BuildImageFailed ·
\`15\` VulnerableImage · \`20\` Locking · \`30\` Claiming · \`40\` **Running** · \`45\` **Restarting** ·
\`50\` Stopping · \`70\` Stopped · \`75\` Expired · \`99\` Error

- **Terminal failure:** \`12, 14, 15, 99\`
- **End states:** \`70, 75\` — and *only* those two
- **In flight:** \`10, 11, 13, 20, 30, 45\` **and \`50\`**

The trap in that table: **\`Stopping (50)\` is not an end state.** It still holds cpu/ram/gpu and
host ports, and the node counts it among its active jobs. A poller that halts at \`50\` reports
"done" while teardown is still in flight. Keep polling to \`70\`.

Status *names* come from this server's own label map, not a \`ServiceStatusNumber[n]\` reverse
lookup — the map is written for humans ("Image pull FAILED", not \`PullImageFailed\`) and does not
degrade to \`undefined\` if the node emits a code a given ocean.js release lags on.

### Money model — the part users get wrong

The **entire window is paid up front**, and the resource reservation lasts the whole of it:

- \`serviceStop\` tears down the container but **keeps** cpu/ram/gpu and host ports reserved
  until \`expiresAt\`. **There is no refund.** Only \`Expired (75)\` releases the reservation.
- \`Error (99)\` also still holds the reservation — and is restartable.
- Because the reservation persists, a later \`serviceRestart\` resumes on the **same** endpoints.
- \`serviceRestart\` is **free**, but requires the start payment to have been **claimed**
  (\`paymentClaimed\` on \`serviceStatus\`). A service whose payment was never claimed cannot be
  restarted — start a new one.
- \`serviceExtend\` bills \`additionalDuration\` **alone**, priced off the **stored** job's
  resources and environment.

So "stop it to save money" is wrong advice: by the time the service is running, the money is
already committed.

### Cost: estimated here, enforced there

There is no \`initializeService\`. The node computes cost at start time as
\`price(resourceId) × amount × ceil(effectiveDuration / 60)\`, where
\`effectiveDuration = max(duration, env.minJobDuration)\`. \`estimateServiceCost\` reimplements
exactly that, but three node behaviours make any client figure an estimate:

1. **\`feeToken\` is matched case-sensitively** by the node (\`fee.feeToken === token\`). Always
   send the token string **verbatim as the env advertised it**.
2. **Unknown resource ids are priced at 0, silently.** A typo'd resource id looks free.
3. **\`minLockSeconds = duration + claimDurationTimeout\`**, and \`claimDurationTimeout\` is
   per-node config (default 3600s) that **no protocol command exposes**.

Pipe \`estimateServiceCost\`'s \`payment\` object straight into \`escrow_preflight\` — it has the
field names that tool already accepts.

### Templates are informational

\`getServiceTemplates\` returns a catalogue **curated by the node owner**: a suggested,
explicitly **non-exhaustive** set of services known to run there. It is **not an allow-list**,
and there is **no \`templateId\` on \`serviceStart\`** — you always pass the spec explicitly.

- An **empty catalogue is normal** (the node just reads a folder) and says nothing about
  whether services work. Never report \`[]\` as "services unavailable".
- ⚠️ A template's \`command\`/\`entrypoint\` are **\`dockerCmd\`/\`dockerEntrypoint\`** on
  \`serviceStart\`. Copied verbatim under their template names they are **silently dropped** and
  the container runs its image default. Use the \`serviceStartArgs\` projection the tool returns.
- \`userConfigurableEnvVars\` keys are **yours** to fill via \`userData\`; \`envVarKeys\` are the
  **operator's** — keys exposed, values never. Do not send those back.

### Restart: REUSE or RESPEC, never partial

- **REUSE** — no container params → restarts on the stored spec.
- **RESPEC** — any of \`image\`/\`tag\`/\`checksum\`/\`dockerfile\`/\`additionalDockerFiles\`/
  \`dockerCmd\`/\`dockerEntrypoint\`/\`userData\` → the container is rebuilt **entirely** from the
  request: \`image\` becomes mandatory and anything omitted is **empty, not inherited**.

There is therefore **no "change only userData" call**. To rotate a secret, do a RESPEC restart
that re-sends the same \`image\` + \`tag\` alongside the new \`userData\`. Since the node strips
\`userData\` from every response, you must re-supply every key you want the container to keep.

### Safety surface

- **\`dockerfile\` = arbitrary build execution** on the operator's Docker daemon. Only works
  where the env sets \`allowImageBuild=true\`; otherwise \`403\`.
- **Endpoints are unauthenticated by the node** — it only port-forwards. URL secrecy is not
  access control; put your own auth in front of anything sensitive.
- **In-container ports must be ≥ 1024**: the container runs with \`CapDrop: ['ALL']\`, so it has
  no \`NET_BIND_SERVICE\` and cannot bind privileged ports.
- **\`getServices\` is node-wide.** You are looking at other consumers' services — never present
  them as the user's own.
- **Secrets in \`userData\` transit the chat/LLM.** Prefer short-lived, narrowly-scoped tokens.

### Endpoint hosts come from the operator

The published URL is \`http://<serviceOnDemand.nodeHost>:<hostPort>\`, and \`nodeHost\` is the
operator's configuration — every node in the network is responsible for advertising a host its
consumers can reach. That may be a public DNS name or, for a node serving an internal network,
a private address; both are legitimate, so hand the URL over as returned. If it does not
resolve for you, either the operator has not configured \`nodeHost\` or you are outside the
network that node serves — both are for the operator to fix, not something to work around here.

### Recommended flow

1. \`findServiceNodes\` / \`findServiceEnvironments\` → a service-capable env with pricing and capacity
2. \`getServiceTemplates\` → a starting point (optional; bring your own image instead)
3. \`estimateServiceCost\` → cost estimate + \`payment\` object
4. \`escrow_preflight\` → fund and authorize
5. \`serviceStart\` → \`serviceId\`
6. \`serviceStatus\` every ~5–10s until \`40\`
7. hand the endpoint URLs to the user; \`serviceLogs\` (with \`since\`) to debug
8. \`serviceExtend\` to lengthen, \`serviceRestart\` to bounce or respec, \`serviceStop\` to tear down`
