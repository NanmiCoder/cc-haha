#!/bin/bash

# Recompile node-pty's Linux module inside Debian bullseye before packaging.
#
# node-pty publishes no Linux prebuilds, so `bun install` compiles pty.node
# against the build host's glibc. On the ubuntu-22.04 release runners that binds
# forkpty/openpty to GLIBC_2.34, and the terminal then fails on Ubuntu 20.04,
# Debian 11 or RHEL 8 even though Electron itself starts there. A bullseye build
# loads on glibc 2.28 and newer; package-smoke enforces that with --max-linux-glibc.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DESKTOP_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
NODE_MODULES_DIR="${DESKTOP_DIR}/node_modules"
BUILD_IMAGE="node:22-bullseye"

if [[ "$(uname -s)" != "Linux" ]]; then
  # The rebuilt module lands in build/Release, which node-pty loads before its
  # platform prebuilds, so running this elsewhere would break the local terminal.
  echo "[rebuild-node-pty-linux] This script must run on Linux." >&2
  exit 1
fi

if [[ ! -f "${NODE_MODULES_DIR}/node-pty/binding.gyp" ]]; then
  echo "[rebuild-node-pty-linux] node-pty is not installed under ${NODE_MODULES_DIR}; run bun install first." >&2
  exit 1
fi

echo "[rebuild-node-pty-linux] Rebuilding node-pty in ${BUILD_IMAGE}..."
docker run --rm \
  --user "$(id -u):$(id -g)" \
  --env HOME=/tmp/node-pty-build-home \
  --volume "${NODE_MODULES_DIR}:/desktop/node_modules" \
  --workdir /desktop/node_modules/node-pty \
  "${BUILD_IMAGE}" \
  bash -euo pipefail -c '
    echo "[rebuild-node-pty-linux] $(ldd --version | head -n 1)"
    node /usr/local/lib/node_modules/npm/node_modules/node-gyp/bin/node-gyp.js rebuild
    node scripts/post-install.js
  '
