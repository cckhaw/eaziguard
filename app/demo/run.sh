#!/usr/bin/env bash
# Local demo: fake Prometheus on :19090 + the dashboard on :3000, no backend needed.
#   npm run demo              # unhealthy campus with sample alerts
#   npm run demo -- healthy   # everything green
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

SCENARIO="${1:-mixed}"
python3 demo/mock-prometheus.py 19090 "$SCENARIO" &
MOCK_PID=$!
trap 'kill "$MOCK_PID" 2>/dev/null || true' EXIT

echo "Dashboard: http://localhost:3000   (scenario: $SCENARIO)"
PROMETHEUS_URL=http://127.0.0.1:19090 PROMETHEUS_BEARER_TOKEN=demo-token \
  npx next dev
