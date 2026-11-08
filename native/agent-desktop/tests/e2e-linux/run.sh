#!/usr/bin/env bash
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
exec python3 -I "$here/runner/prepare.py" "$@"
