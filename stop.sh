#!/usr/bin/env bash
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "================================================="
echo " Stopping Heimdall Stack"
echo "================================================="

docker compose down "$@"

echo "[+] Heimdall containers have been stopped and removed."
