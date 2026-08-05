#!/usr/bin/env bash
#
# End-to-end telemetry check: brings up the local stack, runs on-mcp in SSE mode, drives a few
# tool calls over Streamable HTTP, then asserts that (a) metrics landed in Prometheus and (b) a
# tool span landed in Tempo.
#
#   ./scripts/telemetry/verify-telemetry.sh
#
# Exits non-zero with a summary if any check fails. Safe to re-run; it cleans up what it starts.
#
# Flags:
#   --keep    leave the stack and the server running afterwards (for poking around in Grafana)
#   --no-up   assume the stack is already running

set -uo pipefail

# Guarded: with `set -uo pipefail` (no -e) a failed cd would silently run every check against the
# caller's directory.
cd "$(dirname "$0")/../.." || { echo "cannot cd to repo root" >&2; exit 2; }

COMPOSE_FILE="docs/telemetry/docker-compose.telemetry.yml"
PROM_URL="${PROM_URL:-http://localhost:9090}"
TEMPO_URL="${TEMPO_URL:-http://localhost:3200}"
GRAFANA_URL="${GRAFANA_URL:-http://localhost:3001}"
MCP_PORT="${MCP_PORT:-3000}"
MCP_URL="http://127.0.0.1:${MCP_PORT}/mcp"

KEEP=0
DO_UP=1
for arg in "$@"; do
  case "$arg" in
    --keep) KEEP=1 ;;
    --no-up) DO_UP=0 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

PASS=0
FAIL=0
RESULTS=()

ok()   { PASS=$((PASS+1)); RESULTS+=("  PASS  $1"); printf '  \033[32mPASS\033[0m  %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); RESULTS+=("  FAIL  $1"); printf '  \033[31mFAIL\033[0m  %s\n' "$1"; }
step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

BUILD_LOG=$(mktemp -t on-mcp-build.XXXXXX)
SERVER_LOG=$(mktemp -t on-mcp-server.XXXXXX)
HEADERS=$(mktemp -t on-mcp-init-headers.XXXXXX)
INIT_BODY_FILE=$(mktemp -t on-mcp-init-body.XXXXXX)

SERVER_PID=""
cleanup() {
  rm -f "$BUILD_LOG" "$SERVER_LOG" "$HEADERS" "$INIT_BODY_FILE"

  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  if [ "$KEEP" -eq 0 ] && [ "$DO_UP" -eq 1 ]; then
    docker compose -f "$COMPOSE_FILE" down -v >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

need() { command -v "$1" >/dev/null 2>&1 || { echo "missing required command: $1" >&2; exit 2; }; }
need curl
need docker
need node

# ── 1. stack ────────────────────────────────────────────────────────────────────────────────
if [ "$DO_UP" -eq 1 ]; then
  step "Starting telemetry stack"
  docker compose -f "$COMPOSE_FILE" up -d
fi

wait_for() { # url, label, attempts
  local url="$1" label="$2" tries="${3:-60}"
  for _ in $(seq 1 "$tries"); do
    if curl -fsS -o /dev/null "$url" 2>/dev/null; then ok "$label is up"; return 0; fi
    sleep 2
  done
  bad "$label did not become ready at $url"
  return 1
}

step "Waiting for backends"
wait_for "$PROM_URL/-/ready" "Prometheus"
wait_for "$TEMPO_URL/ready" "Tempo"
wait_for "$GRAFANA_URL/api/health" "Grafana"

# ── 2. build + run the server ───────────────────────────────────────────────────────────────
step "Building on-mcp"
if npm run build >"$BUILD_LOG" 2>&1; then
  ok "build succeeded"
else
  bad "build failed:"
  tail -20 "$BUILD_LOG" >&2 || true
  exit 1
fi

step "Starting on-mcp in SSE mode with telemetry enabled"
export MCP_TRANSPORT=sse
export MCP_PORT
export MCP_HOST=127.0.0.1
export OTEL_EXPORTER_OTLP_ENDPOINT="http://localhost:4318"
export OTEL_SERVICE_NAME="${OTEL_SERVICE_NAME:-ocean-mcp}"
export DEPLOYMENT_ENVIRONMENT=verify
# Export fast so the script does not wait a full minute for the first metric flush.
export OTEL_METRIC_EXPORT_INTERVAL=5000

node --import ./dist/telemetry/otel.js dist/index.js >"$SERVER_LOG" 2>&1 &
SERVER_PID=$!

# Any HTTP status counts as "listening" — POSTing `{}` is deliberately not a valid MCP request and
# returns 400. `curl -f` would treat that as failure and burn the whole retry budget.
for _ in $(seq 1 45); do
  if curl -sS -o /dev/null -X POST "$MCP_URL" -H 'Content-Type: application/json' \
      -H 'Accept: application/json, text/event-stream' -d '{}' 2>/dev/null; then break; fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    bad "server exited during startup (see debug.log)"
    tail -20 "$SERVER_LOG" || true
    exit 1
  fi
  sleep 2
done

if kill -0 "$SERVER_PID" 2>/dev/null; then
  ok "server is running (pid $SERVER_PID)"
else
  bad "server is not running"
  exit 1
fi

if grep -q '\[telemetry\] enabled' debug.log 2>/dev/null; then
  ok "telemetry reported itself enabled in debug.log"
else
  bad "no '[telemetry] enabled' line in debug.log — telemetry did not start"
fi

# ── 3. drive traffic ────────────────────────────────────────────────────────────────────────
step "Driving MCP tool calls"

INIT_BODY='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"verify-telemetry","version":"1.0.0"}}}'

curl -fsS -D "$HEADERS" -o "$INIT_BODY_FILE" -X POST "$MCP_URL" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d "$INIT_BODY" >/dev/null 2>&1

SESSION_ID=$(tr -d '\r' < "$HEADERS" | awk 'tolower($1) == "mcp-session-id:" { print $2 }')
if [ -n "$SESSION_ID" ]; then
  ok "initialized session $SESSION_ID"
else
  bad "no mcp-session-id header returned — cannot drive tool calls"
  cat "$HEADERS" || true
  exit 1
fi

mcp_post() {
  curl -fsS -o /dev/null -X POST "$MCP_URL" \
    -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' \
    -H "mcp-session-id: $SESSION_ID" \
    -d "$1" 2>/dev/null
}

mcp_post '{"jsonrpc":"2.0","method":"notifications/initialized"}'

# Local docs tools: no network, no chain, deterministic.
CALLS=0
for payload in \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_topics","arguments":{}}}' \
  '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"search_docs","arguments":{"query":"compute"}}}' \
  '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"search_docs","arguments":{"query":"zzzzznomatch"}}}' \
  '{"jsonrpc":"2.0","id":5,"method":"tools/list","params":{}}'
do
  if mcp_post "$payload"; then CALLS=$((CALLS+1)); fi
done

if [ "$CALLS" -ge 3 ]; then
  ok "drove $CALLS MCP requests"
else
  bad "only $CALLS MCP requests succeeded"
fi

# Close the session so the end-of-session metrics are emitted too.
curl -fsS -o /dev/null -X DELETE "$MCP_URL" -H "mcp-session-id: $SESSION_ID" 2>/dev/null || true

step "Waiting for export (metric interval ${OTEL_METRIC_EXPORT_INTERVAL}ms + collector batch)"
sleep 25

# ── 4. assert metrics ───────────────────────────────────────────────────────────────────────
step "Checking Prometheus"

prom_value() { # promql -> scalar (empty when no series)
  curl -fsS --get "$PROM_URL/api/v1/query" --data-urlencode "query=$1" 2>/dev/null \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);const r=j.data?.result??[];console.log(r.length?r[0].value[1]:"")}catch{console.log("")}})'
}

check_metric() { # promql, label
  local value
  value=$(prom_value "$1")
  if [ -n "$value" ] && [ "$(printf '%.0f' "$value" 2>/dev/null || echo 0)" -gt 0 ]; then
    ok "$2 (= $value)"
  else
    bad "$2 — no data for: $1"
  fi
}

check_metric 'sum(mcp_tool_calls_total)' 'mcp_tool_calls_total is non-zero'
check_metric 'sum(mcp_sessions_started_total)' 'mcp_sessions_started_total is non-zero'
check_metric 'sum(mcp_docs_search_total)' 'mcp_docs_search_total is non-zero'
check_metric 'count(mcp_users_active_estimate)' 'mcp_users_active_estimate is present'
check_metric 'sum(mcp_tool_duration_milliseconds_count)' 'tool duration histogram has samples'

# Cardinality guard: user.id must never appear as a metric label.
if [ -z "$(prom_value 'count(count by (user_id) (mcp_tool_calls_total))')" ]; then
  ok 'user_id is NOT a metric label (cardinality guard)'
else
  bad 'user_id leaked onto mcp_tool_calls_total as a label'
fi

# Docs search should show both a hit and a miss from the two queries above.
check_metric 'sum(mcp_docs_search_total{result_hit="false"})' 'zero-result docs search was recorded'

# Activation latency fires on the first tool call of the session.
check_metric 'sum(mcp_session_time_to_first_call_seconds_count)' 'activation latency was recorded'

# Transport rejections: drive one deliberately with a session id that does not exist.
curl -fsS -o /dev/null -X POST "$MCP_URL" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'mcp-session-id: 00000000-0000-0000-0000-000000000000' \
  -d '{"jsonrpc":"2.0","id":9,"method":"tools/list","params":{}}' 2>/dev/null || true
sleep 12
check_metric 'sum(mcp_transport_rejected_total{reason="session_not_found"})' \
  'dead session id was counted as a transport rejection'

# ── 5. assert traces ────────────────────────────────────────────────────────────────────────
step "Checking Tempo"

TRACE_JSON=$(curl -fsS --get "$TEMPO_URL/api/search" \
  --data-urlencode 'q={ name =~ "tool\\..*" }' --data-urlencode 'limit=20' 2>/dev/null || echo '')

TRACE_COUNT=$(printf '%s' "$TRACE_JSON" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log((JSON.parse(s).traces??[]).length)}catch{console.log(0)}})')

if [ "${TRACE_COUNT:-0}" -gt 0 ]; then
  ok "found $TRACE_COUNT tool.* trace(s) in Tempo"
else
  bad 'no tool.* spans found in Tempo'
fi

# ── 6. assert the dashboard is provisioned ──────────────────────────────────────────────────
step "Checking Grafana"
if curl -fsS "$GRAFANA_URL/api/dashboards/uid/ocean-mcp-usage" >/dev/null 2>&1; then
  ok 'dashboard ocean-mcp-usage is provisioned'
else
  bad 'dashboard ocean-mcp-usage was not found in Grafana'
fi

# ── summary ─────────────────────────────────────────────────────────────────────────────────
step "Summary"
printf '%s\n' "${RESULTS[@]}"
printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"

if [ "$KEEP" -eq 1 ]; then
  printf '\nStack left running. Dashboard: %s/d/ocean-mcp-usage\n' "$GRAFANA_URL"
  printf 'Stop with: docker compose -f %s down -v\n' "$COMPOSE_FILE"
fi

[ "$FAIL" -eq 0 ]
