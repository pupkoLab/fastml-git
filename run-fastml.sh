#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
node fastml-node-runner.js > fastml-run.log 2>&1
echo "FastML finished. See results/ and fastml-run.log"
