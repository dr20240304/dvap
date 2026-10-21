#!/usr/bin/env bash
# Run the third-party MCP scanners against a running DVAP (make dev / make d-up-attack). Offline analyzers only:
#   - Cisco mcp-scanner, YARA analyzer (no API key, nothing leaves the machine)
#   - Snyk agent-scan `inspect` (lists tools; the full `scan` uploads tool metadata to Snyk and needs a token, so it is not run here)
# Usage: tooling/third_party_scan.sh [mcp-url] [vendor-mcp-url]    (defaults: host ports; token read from the data dir's keys.json)
set -euo pipefail
cd "$(dirname "$0")/.."
VENV="${DVAP_SCAN_VENV:-.scan-venv}"
if [ ! -x "$VENV/bin/mcp-scanner" ]; then
  python3 -m venv "$VENV"
  "$VENV/bin/pip" install -q cisco-ai-mcp-scanner snyk-agent-scan
fi
MCP="${1:-${MCP_URL:-http://127.0.0.1:4100/mcp}}"
VENDOR="${2:-${VENDOR_MCP_URL:-http://127.0.0.1:4300/mcp}}"
TOKEN="$(python3 -c "import json,os,pathlib;print(json.loads((pathlib.Path(os.environ.get('DVAP_DATA_DIR','.dvap-data'))/'keys.json').read_text())['agentToken'])")"
echo "=== Cisco mcp-scanner (YARA) — payments-mcp"
"$VENV/bin/mcp-scanner" --analyzers yara --format table remote --server-url "$MCP" --bearer-token "$TOKEN" || true
echo; echo "=== Cisco mcp-scanner (YARA) — invoice-tools (third party)"
"$VENV/bin/mcp-scanner" --analyzers yara --format table remote --server-url "$VENDOR" || true
CFG="$(mktemp)"; trap 'rm -f "$CFG"' EXIT
printf '{"mcpServers":{"payments-mcp":{"url":"%s","headers":{"Authorization":"Bearer %s"}},"invoice-tools":{"url":"%s"}}}' "$MCP" "$TOKEN" "$VENDOR" > "$CFG"
echo; echo "=== Snyk agent-scan inspect"
"$VENV/bin/snyk-agent-scan" inspect "$CFG" --no-skills --dangerously-run-mcp-servers </dev/null 2>&1 | cut -c1-160 || true
