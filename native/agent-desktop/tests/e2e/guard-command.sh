#!/usr/bin/env bash
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
: "${AGENT_DESKTOP_E2E_BINARY:?AGENT_DESKTOP_E2E_BINARY is required}"

export AGENT_DESKTOP_E2E_INHERIT_LEASE=1
exec python3 "$here/json_tool.py" exec "$AGENT_DESKTOP_E2E_BINARY" "$@"
