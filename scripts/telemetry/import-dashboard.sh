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

set -euo pipefail

cd "$(dirname "$0")/../.."

GRAFANA_URL="${GRAFANA_URL:-http://localhost:3001}"
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
PROM_UID="${PROM_UID:-}"
TEMPO_UID="${TEMPO_UID:-}"

lookup_uid() { # type -> first matching datasource uid
  curl -fsS -H "Authorization: Bearer $GRAFANA_TOKEN" "$GRAFANA_URL/api/datasources" \
    | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);const m=j.find(d=>d.type==='$1');console.log(m?m.uid:'')}catch{console.log('')}})"
}

[ -z "$PROM_UID" ] && PROM_UID=$(lookup_uid prometheus)
[ -z "$TEMPO_UID" ] && TEMPO_UID=$(lookup_uid tempo)

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
