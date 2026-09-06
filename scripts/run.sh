#!/usr/bin/env bash
# Launch the workflow orchestrator.
# Usage: ./scripts/run.sh   (from workflow root)  → http://127.0.0.1:3180
set -euo pipefail
cd "$(dirname "$0")/../packages/orchestrator"
if [ ! -d node_modules ]; then npm install --no-audit --no-fund >/dev/null; fi
echo "Starting Workflow → http://127.0.0.1:3180  (Ctrl+C to stop)"
node src/index.js "$@"
