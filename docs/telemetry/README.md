# Telemetry: usage tracking for `on-mcp`

How to get usage metrics and traces out of the hosted `on-mcp` server and into Grafana.

Following this file top to bottom on a clean machine gets you a live dashboard with real data in
about five minutes. If you only want to confirm it works, skip to
[E. Verify end to end](#e-verify-end-to-end) and run one script.

---

## Contents

- [A. What this is](#a-what-this-is) — architecture, and every metric emitted
- [B. Configure the server](#b-configure-the-server-to-emit-data) — env vars, bootstrap
- [C. Stand up Grafana](#c-stand-up-the-grafana-stack) — local stack, or Grafana Cloud
- [D. Get the dashboard](#d-create--import-the-dashboard) — provisioning or API import
- [E. Verify end to end](#e-verify-end-to-end) — one script, pass/fail
- [F. Troubleshooting](#f-troubleshooting)
- [G. Privacy and data handling](#g-privacy-and-data-handling)

---

## A. What this is

### Scope

**Hosted SSE only.** Telemetry is active when the server runs with `MCP_TRANSPORT=sse` *and* an
OTLP endpoint is configured. It is a hard no-op otherwise.

Local `stdio` installs emit **nothing**, deliberately and permanently: in stdio mode stdout *is*
the JSON-RPC channel, and a single stray write corrupts the protocol. Nothing in the telemetry
path writes to stdout in any mode — diagnostics go through `console.error`, which `index.ts`
already redirects into `debug.log`.

### Data path

```text
                    OTLP/HTTP :4318
on-mcp (SSE) ─────────────────────────►  OTel Collector
  │                                          │
  │ metrics + traces                         ├── remote-write ──►  Prometheus / Mimir  ──┐
  │                                          │                                          ├──►  Grafana
  └── never touches stdout                   └── OTLP ──────────►  Tempo  ───────────────┘
```

The Collector is not optional scaffolding — it is where you add redaction, batching, or a second
backend without redeploying the MCP server. `otel-collector.yaml` ships with a scrub processor as
defence in depth behind the server's own attribute allowlist.

### Metric naming: OTel → Prometheus

This trips people up more than anything else. The OTel Prometheus exporter rewrites names:
dots become underscores, counters gain `_total`, and **the unit is appended for real units**
(annotation units in braces like `{call}` are dropped).

| In the code | In PromQL |
|---|---|
| `mcp.tool.calls` (counter, `{call}`) | `mcp_tool_calls_total` |
| `mcp.tool.duration` (histogram, `ms`) | `mcp_tool_duration_**milliseconds**_bucket` / `_sum` / `_count` |
| `mcp.session.duration` (histogram, `s`) | `mcp_session_duration_**seconds**_bucket` / … |
| `mcp.sessions.active` (up/down counter) | `mcp_sessions_active` (no `_total`) |
| `mcp.users.active.estimate` (gauge) | `mcp_users_active_estimate` |
| attribute `tool.name` | label `tool_name` |

### Every metric emitted

**Core usage**

| Metric | Type | Labels | Answers |
|---|---|---|---|
| `mcp.tool.calls` | Counter | `tool.name`, `tool.category`, `status`, `error.type` | Most-used tools; error rate |
| `mcp.tool.duration` | Histogram (ms) | `tool.name`, `status`, `waited` | Latency p50/p95/p99 |
| `mcp.sessions.active` | UpDownCounter | `client.name` | Concurrent sessions |
| `mcp.sessions.started` | Counter | `client.name`, `client.version` | Unique sessions (upper bound) |
| `mcp.sessions.empty` | Counter | `client.name` | Bounce: initialized, then zero tool calls |
| `mcp.session.duration` | Histogram (s) | `client.name` | Session length |
| `mcp.session.tool_calls` | Histogram | `client.name` | Engagement depth |
| `mcp.session.distinct_tools` | Histogram | `client.name` | Exploration breadth |
| `mcp.session.time_to_first_call` | Histogram (s) | `client.name` | **Activation latency** — how long until the first real action |
| `mcp.transport.rejected` | Counter | `reason` | **Requests that never reached a tool** — see below |
| `mcp.users.active.estimate` | Gauge (HLL) | `window` = `day`/`week`/`month` | **Unique users (lower bound)** |
| `mcp.resource.reads` | Counter | `resource.name` | Resource usage |
| `mcp.prompt.gets` | Counter | `prompt.name` | Prompt template usage |

`mcp.transport.rejected` covers a genuine blind spot. Its three reasons — `session_not_found`,
`invalid_request`, `handler_error` — are requests that die in `mcpHandler` before any tool runs, so
they move **neither** `mcp.tool.calls` (no handler ran) **nor** `mcp.sessions.*` (no session was
created). A `session_not_found` spike means clients are holding session ids that died with the last
restart.

`mcp.session.time_to_first_call` is the complement of `mcp.sessions.empty`: the bounce counter says
*how many* sessions never acted, this says *how long* the rest took to act.

**Ocean domain**

| Metric | Type | Labels | Notes |
|---|---|---|---|
| `mcp.asset.order` | Counter | `status`, `chain.id` | **Dataset ordering** — an in-tool funnel, see below |
| `mcp.asset.downloads` | Counter | `status` | Asset file downloads |
| `mcp.asset.fee_quotes` | Counter | `status` | `get_download_fees` — purchase intent |
| `mcp.ddo.resolve` | Counter | `operation`, `found` | **DDO resolution hit rate** — precondition for everything |
| `mcp.compute.jobs.started` | Counter | `chain.id`, `paid` | `computeStart` + `freeComputeStart` |
| `mcp.compute.jobs.observed` | Counter | `job.status` | Terminal only, deduped per `jobId` |
| `mcp.compute.job.observed_duration` | Histogram (s) | `job.status` | First poll → terminal poll (a lower bound) |
| `mcp.compute.job.polls` | Histogram | `job.status` | Polls a job took to settle |
| `mcp.escrow.preflight` | Counter | `result`, `caller` | See [the caller note](#the-caller-label) |
| `mcp.escrow.autofix` | Counter | `outcome` | `noop` = advisory, not an actual fix |
| `mcp.escrow.tx_built` | Counter | `action`, `status` | Deposit/withdraw/authorize — **intent, not settlement** |
| `mcp.auth.tokens_created` | Counter | — | Paid-compute intent |
| `mcp.p2p.provider_lookup` | Counter | `found` | DID → provider hit rate |
| `mcp.storage.operations` | Counter | `action`, `status` | Persistent-storage bucket/file operations |
| `mcp.incentives.calls` | Counter | `tool.name` | Node-operator onboarding |
| `mcp.chain.usage` | Counter | `chain.id` | Which chains users target |
| `mcp.docs.search` | Counter | `result.hit` | Zero-result rate = content gaps |

Three of these carry caveats worth reading before you trust a panel:

**`mcp.asset.order` counts step transitions, not orders.** `order_asset` is a multi-step state
machine: it returns an unsigned transaction, the caller signs and broadcasts it, then calls back
with `state` + `lastTxHash`. Its `status` field is therefore an **in-tool funnel** — the ratio of
`complete` to `needs_broadcast` is how many order flows finish versus stall after a signature.

Values: `needs_broadcast`, `waiting`, `complete` (from the handler); `error` when the tool throws;
`unknown` when the result had no parseable payload; and `other` for any status string the handler
does not document. The last two are bounding, not behaviour — this label is derived from a result
payload, and the invariant is that every label is bounded at the point of use rather than by trusting
the producer. A non-zero `other` means the handler grew a state the telemetry map has not caught up
with.

**`mcp.escrow.tx_built` is intent, not settlement.** `escrow_deposit`, `escrow_withdraw` and
`escrow_authorize` build an *unsigned* transaction and never broadcast. Settlement happens later
through `broadcast_transaction`, which is generic and cannot be attributed back to escrow. Read this
as "the user was told how to fund their escrow", not "the escrow was funded".

**The duration histograms are lower bounds.** `observed_duration` measures the first poll we saw to
the terminal poll we saw — the job was already running when first observed, and its terminal state
is only noticed at the *next* poll. With a 5–10s polling cadence the error is small, but it is
always an under-estimate, never an over-estimate.

**Service-on-Demand**

| Metric | Type | Labels | Notes |
|---|---|---|---|
| `mcp.service.started` | Counter | `chain.id`, `image.mode` | Counts **attempts** — start is async |
| `mcp.service.observed` | Counter | `service.status` | Terminal + `running`, deduped per `serviceId` |
| `mcp.service.cost_estimates` | Counter | `chain.id`, `estimated` | Pricing/shopping signal |
| `mcp.service.lifecycle` | Counter | `action` | extend/restart/stop/logs/list |
| `mcp.service.time_to_running` | Histogram (s) | — | **How long a start actually takes** — escrow lock + image pull/build + scan |
| `mcp.service.observed_duration` | Histogram (s) | `service.status` | First poll → terminal poll (a lower bound) |
| `mcp.service.polls` | Histogram | `service.status` | Polls a service took to settle |

**Health and runtime**

| Metric | Source |
|---|---|
| `mcp.p2p.connected_peers` | Live libp2p **connections** (not discovered peers) |
| `v8js.memory.heap.*`, `nodejs.eventloop.delay.*` | `@opentelemetry/instrumentation-runtime-node` |
| `process.*`, `system.*` | `@opentelemetry/host-metrics` |
| `http.server.request.duration` | `@opentelemetry/instrumentation-http` + `-express` |

Heap headroom is a **recording rule** (`rules.yml`), not a bespoke gauge — the raw V8 heap series
are already exported and a custom instrument would only duplicate them.

**Traces.** One span per tool call, named `tool.<name>`, carrying exactly `tool.name`,
`tool.category`, `session.id`, `user.id`, `status`, `error.type`. Nothing else, ever.

### Unique users: why it is a range, not a number

Without authentication there is no exact user count, so the dashboard shows a **bracket**:

- **Lower bound — `mcp.users.active.estimate`.** An in-process HyperLogLog of
  `sha256(client IP + client name)`. Users behind one NAT collapse into one id, so this
  under-counts. It is an estimate (~1% error at this register count).
- **Upper bound — `mcp.sessions.started`.** Session ids are fresh UUIDs, so
  `increase(mcp_sessions_started_total[range])` *is* the distinct session count. Every reconnect
  counts again, so this over-counts.

The real figure sits between the two lines.

**No configuration is required.** The hash is unsalted, so a given user maps to the same id in
every process, after every restart, on every replica — there is no secret to provision, keep in
sync, or accidentally omit, and no failure mode where a missing value silently disables the count.
The trade-off is that `user.id` is **pseudonymous, not anonymous**: the input space is small (IPv4
plus a ~20-value client allowlist), so anyone holding the telemetry can brute-force it back to an
IP. Scope access to Prometheus/Tempo accordingly, and see [section G](#g-privacy-and-data-handling).

Two properties of the HLL are deliberate and documented rather than "fixed":

1. **Windows are calendar buckets, not sliding windows.** Each sketch resets at its UTC boundary
   and lives only in memory, so a restart mid-window under-counts until it re-accumulates. **A
   post-deploy DAU dip is an artefact, not a real drop** — the dashboard panel says so too.
2. **Single instance only.** Per-replica estimates cannot be summed; that needs a sketch union.
   Revisit this before scaling the SSE server past one replica.

Source port is deliberately **not** part of the user id. TCP source ports are per-connection and
re-mapped by NAT PAT, and Streamable HTTP opens several connections per session, so folding one in
produces a *connection* id that fragments a single user across their own requests.
`MCP_TELEMETRY_USER_ID_INCLUDE_PORT=1` exists only to experiment with that; leave it off.

### The `caller` label

`mcp.escrow.preflight` is recorded inside `runEscrowPreflight`, **not** in the tool wrapper,
because that function has three call sites and only one of them is a tool:

| Call site | `caller` |
|---|---|
| the `escrow_preflight` tool | `tool` |
| the tool's post-auto-fix re-check | `tool_recheck` |
| `escrowPreflightGate`, inside `computeStart` | `compute_gate` |
| `serviceEscrowGate`, inside `serviceStart` | `service_gate` |

Most preflights are the implicit gates. Hooking the tool name would leave both gates at zero and
make the paid-compute and service funnels look like a total drop-off at the payment step.
**`caller=~".*_gate"` is the actionable series** — those users hit escrow friction without asking
for a check.

The `result` label takes one of:

| `result` | Meaning |
|---|---|
| `ready` | `canStartThisJob` was true — the node would accept the lock |
| `blocked_insufficient_funds` | Not enough deposited |
| `blocked_missing_authorization` | No authorization for this payee |
| `blocked_authorization_limits` | Authorization exists but is below the per-job minimum |
| `blocked_unknown` | Blocked with no reason set (should not happen; bounded defensively) |
| `error` | **No verdict reached** — an escrow RPC read failed, the contract was unreachable, an address was malformed |

`error` exists because both gates deliberately swallow their failures and proceed ("let the node
decide"). Without it, an escrow backend that is down looks like *reduced preflight traffic* rather
than a fault. It is therefore excluded from `ocean_mcp:escrow_gate_block_rate` — counting it as
blockage would blame payment friction for an infrastructure problem — and surfaced separately as
`ocean_mcp:escrow_preflight_error_rate`.

---

## B. Configure the server to emit data

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | *(unset)* | Collector endpoint. **Unset → telemetry off.** |
| `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` | *(unset)* | Metrics-only endpoint; accepted as a fallback when the one above is unset |
| `OTEL_EXPORTER_OTLP_HEADERS` | — | Auth headers, if exporting past a Collector |
| `MCP_TELEMETRY_ENABLED` | `auto` | `auto` = on when SSE + endpoint set; `false` = hard off |
| `MCP_TELEMETRY_USER_ID_SALT` | *(unset)* | Optional. Makes `user.id` non-invertible — see [privacy](#g-privacy-and-data-handling) |
| `MCP_TELEMETRY_USER_ID_INCLUDE_PORT` | `0` | Experimental; leave off |
| `MCP_TELEMETRY_HEALTH_INTERVAL_MS` | `30000` | Health gauge sampling |
| `OTEL_SERVICE_NAME` | `ocean-mcp` | Resource attribute |
| `OTEL_SERVICE_VERSION` | `0.0.1` | Resource attribute |
| `DEPLOYMENT_ENVIRONMENT` | `NODE_ENV` | `production` / `staging` / … |
| `OTEL_METRIC_EXPORT_INTERVAL` | `60000` | Metric flush interval (ms) |
| `OTEL_TRACES_SAMPLER` / `_ARG` | `parentbased_always_on` | Turn down under load |
| `TRUST_PROXY` | `loopback` | Express trust-proxy — **must match your topology**, see below |

### `TRUST_PROXY` values

This decides which hop `req.ip` reads, and therefore whether `user.id` identifies the **client** or
your **load balancer**. Get it wrong and every user collapses onto one anonymous id.

| Value | Meaning | Use when |
|---|---|---|
| `loopback` *(default)* | Trust `127.0.0.1/8`, `::1/128` | Proxy runs on the same host |
| `uniquelocal` | Trust RFC1918 — `10/8`, `172.16/12`, `192.168/16`, `fc00::/7` | Proxy is elsewhere on a private network |
| `linklocal` | Trust `169.254.0.0/16`, `fe80::/10` | Rarely useful here |
| `10.0.0.0/8` | Trust that address or CIDR block | You know the proxy's address |
| `loopback, 10.0.0.0/8` | Comma-separated list; any match trusts | Mixed topology |
| `1`, `2`, … | Trust exactly N hops from the server | Fixed, known proxy-chain depth — **the safest choice behind a CDN** |
| `true` | Trust every hop — take the leftmost `X-Forwarded-For` entry | ⚠️ Only when a proxy you control always rewrites the header |
| `false` | Trust nothing — `req.ip` is the socket address | Direct exposure, no proxy |

**Do not use `true` on a publicly reachable server.** `X-Forwarded-For` is client-supplied, so
trusting every hop lets any caller pick their own `user.id` by setting the header. A hop count
(`1`, `2`) or an explicit CIDR is the safe form — both anchor trust to your infrastructure rather
than to what the request claims.

Common setups:

```bash
TRUST_PROXY=loopback              # nginx on the same host (default)
TRUST_PROXY=1                     # exactly one proxy in front (typical ALB / nginx / Caddy)
TRUST_PROXY=2                     # CDN → load balancer → app
TRUST_PROXY=10.0.0.0/8            # proxy on a known private range
TRUST_PROXY=false                 # no proxy at all
```

To confirm it is right, compare the two bounds on the dashboard's user-range panel. If unique users
sits at exactly `1` while sessions climb, `req.ip` is returning the proxy address.

> **Type coercion is handled for you.** Express dispatches on the runtime *type* of this setting,
> and environment variables are always strings, so the server converts `"true"`/`"false"` to
> booleans and a bare integer to a number before handing it over. Passing them through raw would
> make `TRUST_PROXY=true` **throw** at startup (`invalid IP address: true`) and `TRUST_PROXY=1`
> **silently parse as an IP literal** that never matches — disabling `X-Forwarded-For` entirely.
> An empty or unparseable value falls back to `loopback` rather than crashing.

### Running

Telemetry must be initialized before `express`/`http` are imported, or HTTP auto-instrumentation
has nothing to patch. The `start` script already does this with Node's `--import`:

```json
"start": "node --import ./dist/telemetry/otel.js --max-old-space-size=28784 ... dist/index.js"
```

Copy-paste to run locally against the stack from section C:

```bash
npm run build

export MCP_TRANSPORT=sse
export MCP_PORT=3000
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
export DEPLOYMENT_ENVIRONMENT=local
export TRUST_PROXY=loopback

npm start
```

### Confirming export is happening

The server logs one line at startup. It goes to `debug.log`, never stdout:

```bash
grep telemetry debug.log
# [telemetry] enabled — exporting to http://localhost:4318 as service.name=ocean-mcp
```

Other forms you may see:

```text
[telemetry] disabled — OTEL_EXPORTER_OTLP_ENDPOINT is not set
[telemetry] disabled — MCP_TELEMETRY_ENABLED is off
```

In stdio mode the line is suppressed entirely — that is the default mode, not a misconfiguration.

Then check the Collector is receiving:

```bash
docker compose -f docs/telemetry/docker-compose.telemetry.yml logs otel-collector | tail -20
```

---

## C. Stand up the Grafana stack

### Local / dev

```bash
docker compose -f docs/telemetry/docker-compose.telemetry.yml up -d
```

Brings up OTel Collector (`:4318`), Prometheus (`:9090`), Tempo (`:3200`) and Grafana (`:3001`),
with both datasources **and** the dashboard provisioned on boot. No manual setup.

A fifth service, `tempo-init`, runs once and exits — it chowns the Tempo volume so the non-root
Tempo container (uid 10001) can create `/var/tempo/{wal,blocks}`. Seeing it as `Exited (0)` in
`docker compose ps` is correct.

Grafana is on **3001**, not its usual 3000, because the MCP server's default `MCP_PORT` is 3000.

Open <http://localhost:3001/d/ocean-mcp-usage> (anonymous admin, no login).

Tear down:

```bash
docker compose -f docs/telemetry/docker-compose.telemetry.yml down -v
```

### Grafana Cloud / an existing stack

The server side does not change — it always speaks OTLP to a Collector. Point the Collector's two
exporters at your backends in `otel-collector.yaml`:

```yaml
exporters:
  prometheusremotewrite:
    endpoint: https://prometheus-prod-XX.grafana.net/api/prom/push
    headers:
      authorization: Basic ${env:GRAFANA_CLOUD_PROM_AUTH}   # base64("<instanceID>:<token>")

  otlp/tempo:
    endpoint: tempo-prod-XX.grafana.net:443
    headers:
      authorization: Basic ${env:GRAFANA_CLOUD_TEMPO_AUTH}
    tls:
      insecure: false
```

Keep credentials in the Collector's environment, not in the file. The MCP server itself needs no
credentials — it talks to your Collector. `OTEL_EXPORTER_OTLP_HEADERS` on the server is only for
the (unusual) case of exporting straight past the Collector to a remote endpoint.

Then import the dashboard with the script in section D.

---

## D. Create / import the dashboard

### Method 1 — provisioning (recommended)

Already done by the local compose stack. For your own Grafana, mount two paths:

```
docs/telemetry/grafana/dashboards/     → /var/lib/grafana/dashboards
docs/telemetry/grafana/provisioning/   → /etc/grafana/provisioning
```

Grafana loads the dashboard into an "Ocean MCP" folder at startup and reloads it every 30s.
`allowUiUpdates: false` — the JSON in git is the source of truth, so UI edits are overwritten. To
change a panel, edit the JSON and commit it.

### Method 2 — API import

```bash
GRAFANA_URL=https://your-org.grafana.net \
GRAFANA_TOKEN=glsa_xxx \
./scripts/telemetry/import-dashboard.sh
```

The script resolves your Prometheus and Tempo datasource UIDs automatically and binds the
dashboard's `DS_PROMETHEUS` / `DS_TEMPO` variables to them.

To mint the token: Grafana → Administration → Users and access → Service accounts → Add service
account → role **Editor** → Add service account token.

### Method 3 — pure UI

Dashboards → New → Import → paste the contents of
`docs/telemetry/grafana/dashboards/ocean-mcp-usage.json` → select your Prometheus and Tempo
datasources when prompted.

### The panels

| Row | Panels |
|---|---|
| **Users & sessions** | User range (lower ↔ upper bound), DAU/WAU/MAU, concurrent sessions, session length, bounce rate, engagement, clients, client versions |
| **Tool usage** | Top 15 tools, usage by product area, latency p50/p95/p99, slowest tools, errors by type, error rate by tool, overall error rate |
| **Ocean domain** | Compute starts (paid/free), compute outcomes, chain usage, escrow friction by caller, paid-compute funnel, auth tokens, provider hit rate, docs hit rate, auto-fix outcomes, incentives |
| **Service-on-Demand** | Start success rate, service funnel, service outcomes, starts by image mode, lifecycle actions, `serviceStatus` latency split |
| **Asset consumption** | Order funnel, order completion rate, downloads and fee quotes, DDO hit rate, DDO by operation, escrow transactions built |
| **Activation & transport** | Requests rejected before reaching a tool, activation latency, errors by type incl. `auth`, auth failure share, storage operations |
| **Job & service timing** | Compute observed duration, service time-to-Running, poll depth per job/service |
| **Server health** | libp2p connections, heap headroom, event-loop delay, HTTP rate and latency |
| **Drill-down** | TraceQL recipes for per-user investigation |

Two panels deserve a closer look:

**Service start success rate.** `serviceStart` is asynchronous: it validates, persists a
`Starting (10)` record, returns a `serviceId`, and only then runs escrow lock → image pull → container
start in the background. A doomed start therefore returns a *successful-looking* response and dies
minutes later at the Locking step. `observed{running} / started` is the only place that failure is
visible.

**Service time to Running.** This is the honest cost of starting a service — escrow lock, image
pull or build, vulnerability scan, container start. It is the number to quote when someone asks
"how long does a service take to come up", and the one to watch after any node-side change.

**Poll depth.** How many `computeStatus`/`serviceStatus` calls a client makes before something
settles. This is the real cost of the polling UX, and the number `waitForRunning` exists to reduce
— if it is not falling for services, that option is not being used.

**Tool latency.** Every latency panel filters `waited!="true"`.
`serviceStatus{waitForRunning: true}` blocks for up to `MAX_WAIT_FOR_RUNNING_SECONDS` on purpose;
without the filter those calls dominate p95/p99 for every other tool.

Time range and refresh are the standard Grafana controls at the top right. Panels use `$__range`
(dashboard range) or `$__rate_interval` (auto-sized rate window), so they follow it automatically.

---

## E. Verify end to end

```bash
./scripts/telemetry/verify-telemetry.sh
```

It brings up the stack, builds and runs the server in SSE mode, drives real MCP tool calls over
Streamable HTTP, waits for export, then asserts on Prometheus and Tempo. Expected output:

```text
==> Waiting for backends
  PASS  Prometheus is up
  PASS  Tempo is up
  PASS  Grafana is up

==> Starting on-mcp in SSE mode with telemetry enabled
  PASS  build succeeded
  PASS  server is running (pid 12345)
  PASS  telemetry reported itself enabled in debug.log

==> Driving MCP tool calls
  PASS  initialized session 6f1c…
  PASS  drove 4 MCP requests

==> Checking Prometheus
  PASS  mcp_tool_calls_total is non-zero (= 4)
  PASS  mcp_sessions_started_total is non-zero (= 1)
  PASS  mcp_docs_search_total is non-zero (= 2)
  PASS  mcp_users_active_estimate is present
  PASS  tool duration histogram has samples
  PASS  user_id is NOT a metric label (cardinality guard)
  PASS  zero-result docs search was recorded
  PASS  activation latency was recorded (= 1)
  PASS  dead session id was counted as a transport rejection (= 1)

==> Checking Tempo
  PASS  found 4 tool.* trace(s) in Tempo

==> Checking Grafana
  PASS  dashboard ocean-mcp-usage is provisioned

19 passed, 0 failed
```

Exits non-zero if anything fails. Useful flags:

- `--keep` — leave the stack and server running so you can browse Grafana afterwards
- `--no-up` — assume the stack is already running

Unit tests need none of this and run offline against in-memory exporters:

```bash
npm run test:unit
```

---

## F. Troubleshooting

**No data anywhere.** Work down the path:

1. `grep telemetry debug.log` → is it `enabled`? If it says `disabled`, the reason is in the line.
2. Is `MCP_TRANSPORT=sse`? stdio emits nothing by design.
3. Is `OTEL_EXPORTER_OTLP_ENDPOINT` reachable *from the server process*?
   `curl -v http://localhost:4318/v1/metrics` should not connection-refuse.
4. Collector logs: `docker compose -f docs/telemetry/docker-compose.telemetry.yml logs otel-collector`
5. Prometheus is started with `--web.enable-remote-write-receiver`. Without it the Collector logs
   404s and nothing lands. The shipped compose file sets it.
6. Wait one full `OTEL_METRIC_EXPORT_INTERVAL` (default 60s) plus the Collector's 10s batch.

**A metric name returns nothing.** Check the unit suffix — it is
`mcp_tool_duration_milliseconds_bucket`, not `mcp_tool_duration_bucket`. See
[the naming table](#metric-naming-otel--prometheus).

**`mcp_escrow_preflight_total` is flat at zero while compute or service starts are happening.**
The counter was hooked on the tool name instead of inside `runEscrowPreflight`. Check for
`caller="compute_gate"` / `caller="service_gate"` series — if only `caller="tool"` exists, the
gates are not instrumented.

**`mcp_service_observed_total` far exceeds `mcp_service_started_total`.** The `serviceId` dedup set
is not being consulted. Clients poll `serviceStatus` every 5–10s, so a missing dedup over-counts
by 20–100×.

**Services reported as "successful" when they were stopped.** The compute classifier is being
applied to service statuses. `70` means **success** for a compute job and **stopped** for a
service — they are separate vocabularies and must not share a classifier.

**`serviceStatus` p99 latency in the tens of seconds.** The panel is not filtering
`waited!="true"`; you are seeing the deliberate `waitForRunning` block.

**`mcp_transport_rejected_total{reason="session_not_found"}` spikes after every deploy.** Expected:
clients retry with session ids that died with the old process. A *sustained* high rate is not —
that suggests sessions are being evicted or the process is restarting unexpectedly.

**`mcp_asset_order_total` shows `needs_broadcast` but almost no `complete`.** Users are starting
order flows and abandoning them mid-signature. The tool never signs or broadcasts, so the drop-off
is in the client's signing step, not on the server.

**`ocean_mcp:escrow_preflight_error_rate` is climbing.** Preflights cannot reach a verdict — an
escrow RPC endpoint is failing or the contract address is wrong for that chain. Both gates proceed
regardless, so the user-visible symptom is compute/service starts failing *later* at the node
instead of being refused up front.

**`mcp_asset_order_total{status="other"}` is non-zero.** `order_asset` returned a status the
telemetry map does not know about — the handler grew a state. Add it to `ASSET_ORDER_STATUSES` in
`src/telemetry/inspectResult.ts`.

**`mcp_escrow_tx_built_total` is high but escrow never gets funded.** Expected and not a bug: these
tools build unsigned transactions. Settlement happens through `broadcast_transaction`, which is
generic and deliberately not attributed back to escrow.

**Observed durations look too short.** They are lower bounds by construction — measured from the
first poll we saw to the terminal poll we saw, not from real job start. With a 5–10s polling cadence
the error is small, but it always under-estimates.

**Unique users looks wrong.**

- *Too low* → NAT collapse. That is the lower bound behaving as designed; compare with the
  sessions upper bound.
- *A dip right after a deploy* → expected. Calendar-bucket sketches are in-memory and
  re-accumulate over the rest of the window.
- *Inflated across replicas* → per-instance HLL estimates cannot be summed. This is a
  single-instance metric until someone adds sketch union.
- *All users share one id* → `req.ip` is returning the proxy address. Set `TRUST_PROXY` to match
  your topology — see [the value table](#trust_proxy-values). A hop count (`TRUST_PROXY=1`) is the
  usual fix behind a single load balancer.
- *Unique users implausibly high, or trivially spoofable* → `TRUST_PROXY=true` on a publicly
  reachable server. `X-Forwarded-For` is client-supplied, so any caller can choose their own id.
  Use a hop count or an explicit CIDR instead.

**Cardinality warnings from Prometheus/Mimir.** Confirm `user_id` is not a metric label:

```promql
count(count by (user_id) (mcp_tool_calls_total))
```

That must return **no data**. `user.id` belongs on spans only. Also check `client_name` — it is
sanitized to an allowlist plus `other`, so an explosion there means the sanitizer was bypassed.

---

## G. Privacy and data handling

### Recorded

Only bounded enums, booleans, and numerics: `tool.name`, `tool.category`, `status`, `error.type`
(a seven-value enum — `auth`, `validation`, `not_found`, `p2p_timeout`, `network`,
`onchain_revert`, `internal` — never the message), `chain.id`, `job.status`, `service.status`,
`operation`, `reason`, `result`,
`caller`, `action`, `image.mode`, `paid`, `auto_fixed`, `found`, `result.hit`, `waited`,
`estimated`, `client.name`, `client.version`, `resource.name`, `prompt.name`, `session.id`, and
`user.id` (hashed, **spans only**).

### Never recorded

Raw tool arguments · `privateKey` · wallet addresses · DIDs · auth tokens · `jobId` and `serviceId`
(in-memory dedup keys only) · free-text query strings · error messages and stack traces · container
image tags, checksums and Dockerfile bodies · `userData` contents · service logs · endpoint URLs ·
port numbers · cost amounts · escrow deposit/withdraw amounts · storage bucket ids, file names and
object keys · transaction hashes.

The `image.mode` label is derived — it records *which* of `tag`/`checksum`/`dockerfile` was used,
never the value.

Enforced in three places: a hard allowlist in `instrumentTools.ts`, a unit test that fails if any
attribute outside the allowlist reaches a span, and the scrub processor in `otel-collector.yaml`.

### How `user.id` is derived

```text
user.id = sha256([salt + "|"] + client_ip + "|" + sanitized_client_name).hex[0..16]
```

The raw IP is used to compute it and immediately discarded — never stored, logged, or exported.
No id is produced when the client IP cannot be determined, and that session simply contributes
nothing to the estimate.

**The hash is unsalted by default, and that is a deliberate trade.** It buys zero-configuration
stability: identity holds across restarts and replicas with no secret to manage. It costs
non-invertibility — the input space is IPv4 (2³²) times a ~20-value client allowlist, so the full
table is computable, and someone holding only the telemetry could map ids back to IP addresses.

By default, treat `user.id` as **pseudonymous, not anonymous**:

- Scope Prometheus/Tempo access the way you would scope access to IP logs.
- Do not publish dashboards or trace exports containing `user.id` outside that boundary.

### Opting into a non-invertible id

Set `MCP_TELEMETRY_USER_ID_SALT` and the salt is mixed into the hash, making it infeasible to
brute-force back to an IP:

```bash
MCP_TELEMETRY_USER_ID_SALT=$(openssl rand -hex 32)
```

It is opt-in rather than the default because the salt then **defines identity continuity**:

- It must stay byte-identical **forever** and across **every replica**. Store it in your secret
  manager, not in an image or a compose file that gets regenerated.
- Rotating or losing it re-identifies your entire user base as new, so DAU/WAU/MAU spike for one
  window. Rotate at a window boundary and annotate the dashboard.
- It changes the id space, so salted and unsalted ids never collide — expect a one-window
  discontinuity when you first enable it.
- Do **not** derive it from `PRIVATE_KEY`: that key is optional and randomly generated per boot when
  unset (`index.ts`), which would silently reset user identity on every restart.

Everything else — the HLL, the gauge, the spans, the dashboard — is unaffected either way.

### Retention

Spans carry `user.id`, so their lifetime bounds how long a re-identifiable record exists. The local
stack sets **24h** (`compaction.block_retention` in `tempo.yaml`); keep that value and this note in
step whenever you change either. Metrics carry no `user.id` and follow your Prometheus/Mimir
retention.

### Client-supplied labels

`client.name` and `client.version` come from the MCP `initialize` params and are **client-controlled
free text** — the one genuine cardinality risk in the metric set. Both are sanitized before use:
names are matched against an allowlist and bucketed as `other` otherwise, versions are reduced to a
numeric prefix, and both are length-capped.
