#!/usr/bin/env bash
#
# Upload the on-mcp dashboard to a running Grafana via the HTTP API.
#
# Only needed when you are NOT using file provisioning (the local docker-compose stack already
# provisions it on boot). Use this for Grafana Cloud or an existing shared Grafana.
#
#   GRAFANA_URL=https://your-org.grafana.net \
#   GRAFANA_TOKEN=glsa_xxx \
#   ./scripts/telemetry/import-dashboard.sh
#
# Minting a token: Grafana → Administration → Users and access → Service accounts →
# Add service account → role "Editor" → Add service account token. Copy it into GRAFANA_TOKEN.
#
# Optional:
#   GRAFANA_FOLDER_UID   target folder (default: the "General" folder)
#   DASHBOARD_FILE       path to the dashboard JSON
#   PROM_UID / TEMPO_UID   datasource uid, used verbatim (skips lookup)
#   PROM_NAME / TEMPO_NAME datasource name to match, when several of a type exist

set -euo pipefail

cd "$(dirname "$0")/../.."

# Exported, not just assigned: the final `node -e` block reads it from `process.env`.
export GRAFANA_URL="${GRAFANA_URL:-http://localhost:3001}"
DASHBOARD_FILE="${DASHBOARD_FILE:-docs/telemetry/grafana/dashboards/ocean-mcp-usage.json}"

if [ ! -f "$DASHBOARD_FILE" ]; then
  echo "dashboard JSON not found: $DASHBOARD_FILE" >&2
  exit 1
fi

if [ -z "${GRAFANA_TOKEN:-}" ]; then
  echo "GRAFANA_TOKEN is required (service-account token with Editor rights)." >&2
  echo "See the header of this script for how to mint one." >&2
  exit 1
fi

# The dashboard declares DS_PROMETHEUS / DS_TEMPO datasource variables. Resolve them to the
# datasource UIDs on the target Grafana so the imported copy is immediately usable.
#
# Resolution is deliberately not "pick the first one": a shared Grafana (the very case this script
# exists for) routinely has several Prometheus datasources, and silently grabbing whichever the API
# lists first points the dashboard at the wrong backend. The tiers below fail loudly on ambiguity
# instead — override with PROM_UID / TEMPO_UID (exact) or PROM_NAME / TEMPO_NAME (by name).
PROM_UID="${PROM_UID:-}"
TEMPO_UID="${TEMPO_UID:-}"

# resolve_uid TYPE WANTED_NAME
#   Prints the resolved uid on stdout, or empty when no datasource of TYPE exists (caller decides
#   whether that is fatal). Exits non-zero — after a diagnostic on stderr — when the choice is
#   ambiguous or a requested name does not match, so `$(...) || exit 1` at the call site stops here.
resolve_uid() {
  curl -fsS -H "Authorization: Bearer $GRAFANA_TOKEN" "$GRAFANA_URL/api/datasources" \
    | DS_TYPE="$1" WANT_NAME="${2:-}" node -e '
      let s = ""
      process.stdin.on("data", (d) => (s += d)).on("end", () => {
        const type = process.env.DS_TYPE
        const want = (process.env.WANT_NAME || "").trim()
        const envPrefix = type === "prometheus" ? "PROM" : "TEMPO"
        let list
        try { list = JSON.parse(s) } catch {
          process.stderr.write(`could not parse ${process.env.GRAFANA_URL}/api/datasources response\n`)
          process.exit(2)
        }
        const cands = Array.isArray(list) ? list.filter((d) => d.type === type) : []
        const show = () =>
          cands.map((d) => `    - ${d.name} (uid=${d.uid}${d.isDefault ? ", default" : ""})`).join("\n") ||
          "    (none)"

        // Tier 2 — explicit name (exact, case-insensitive).
        if (want) {
          const m = cands.filter((d) => String(d.name).toLowerCase() === want.toLowerCase())
          if (m.length === 1) return void process.stdout.write(m[0].uid)
          process.stderr.write(
            `${m.length === 0 ? "no" : "multiple"} ${type} datasource(s) named "${want}". Candidates:\n${show()}\n`
          )
          return void process.exit(3)
        }

        if (cands.length === 0) return void process.stdout.write("") // none: caller decides
        if (cands.length === 1) return void process.stdout.write(cands[0].uid)

        // Tier 3 — the datasource marked default.
        const def = cands.filter((d) => d.isDefault)
        if (def.length === 1) return void process.stdout.write(def[0].uid)

        // Tier 5 — ambiguous: refuse to guess.
        process.stderr.write(
          `multiple ${type} datasources on ${process.env.GRAFANA_URL}; ` +
            `set ${envPrefix}_UID or ${envPrefix}_NAME to pick one. Candidates:\n${show()}\n`
        )
        process.exit(4)
      })
    '
}

if [ -z "$PROM_UID" ]; then
  PROM_UID=$(resolve_uid prometheus "${PROM_NAME:-}") || exit 1
fi
if [ -z "$TEMPO_UID" ]; then
  TEMPO_UID=$(resolve_uid tempo "${TEMPO_NAME:-}") || exit 1
fi

if [ -z "$PROM_UID" ]; then
  echo "No Prometheus datasource found on $GRAFANA_URL — add one first, or set PROM_UID." >&2
  exit 1
fi
if [ -z "$TEMPO_UID" ]; then
  echo "warning: no Tempo datasource found; the trace drill-down panel will need manual wiring." >&2
fi

echo "Importing $DASHBOARD_FILE → $GRAFANA_URL"
echo "  Prometheus datasource: $PROM_UID"
echo "  Tempo datasource:      ${TEMPO_UID:-<none>}"

PAYLOAD=$(
  DASHBOARD_FILE="$DASHBOARD_FILE" \
  PROM_UID="$PROM_UID" \
  TEMPO_UID="$TEMPO_UID" \
  FOLDER_UID="${GRAFANA_FOLDER_UID:-}" \
  node -e '
    const fs = require("fs")
    const dashboard = JSON.parse(fs.readFileSync(process.env.DASHBOARD_FILE, "utf8"))
    // Strip the id so Grafana creates or updates by uid rather than rejecting a stale id.
    dashboard.id = null
    const inputs = [
      { name: "DS_PROMETHEUS", type: "datasource", pluginId: "prometheus", value: process.env.PROM_UID }
    ]
    if (process.env.TEMPO_UID) {
      inputs.push({ name: "DS_TEMPO", type: "datasource", pluginId: "tempo", value: process.env.TEMPO_UID })
    }
    const body = { dashboard, overwrite: true, inputs }
    if (process.env.FOLDER_UID) body.folderUid = process.env.FOLDER_UID
    process.stdout.write(JSON.stringify(body))
  '
)

RESPONSE=$(
  curl -fsS -X POST "$GRAFANA_URL/api/dashboards/import" \
    -H "Authorization: Bearer $GRAFANA_TOKEN" \
    -H 'Content-Type: application/json' \
    -d "$PAYLOAD"
)

echo "$RESPONSE" | node -e '
  let s = ""
  process.stdin.on("data", (d) => (s += d)).on("end", () => {
    try {
      const j = JSON.parse(s)
      console.log(`\nImported: ${j.title ?? "ocean-mcp-usage"}`)
      console.log(`URL: ${process.env.GRAFANA_URL}${j.importedUrl ?? "/d/ocean-mcp-usage"}`)
    } catch {
      console.log(s)
    }
  })
'
