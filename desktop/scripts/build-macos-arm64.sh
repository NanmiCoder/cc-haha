#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DESKTOP_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${DESKTOP_DIR}/.." && pwd)"

TARGET_TRIPLE="aarch64-apple-darwin"
CANONICAL_OUTPUT_DIR="${DESKTOP_DIR}/build-artifacts/macos-arm64"
ELECTRON_OUTPUT_DIR="${DESKTOP_DIR}/build-artifacts/electron"
ELECTRON_BUILDER_CLI="${DESKTOP_DIR}/node_modules/electron-builder/out/cli/cli.js"

usage() {
  cat <<'EOF'
Build Claude Code Haha desktop for macOS Apple Silicon with Electron Builder.

Usage:
  ./desktop/scripts/build-macos-arm64.sh [extra electron-builder args...]

Environment:
  SKIP_INSTALL=1   Skip `bun install` in the repo root and desktop app.
  SIGN_BUILD=1     Allow electron-builder to auto-discover signing identities.
  REBUILD_NATIVE=1 Run `electron-builder install-app-deps` before packaging.
  MAC_TARGETS      Electron Builder macOS targets. Defaults to "dmg zip".
  SKIP_PACKAGE_SMOKE=1
                   Skip package-smoke verification after copying artifacts.
  REQUIRE_MACOS_GATEKEEPER_SMOKE=1
                   Require Gatekeeper approval during post-build package-smoke.
  OPEN_OUTPUT=1    Open the canonical artifact output directory in Finder after a successful build.
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "[build-macos-arm64] This script must run on macOS." >&2
  exit 1
fi

if [[ "$(uname -m)" != "arm64" ]]; then
  echo "[build-macos-arm64] This script is intended for Apple Silicon hosts (arm64)." >&2
  exit 1
fi

for command in bun node codesign hdiutil; do
  if ! command -v "${command}" >/dev/null 2>&1; then
    echo "[build-macos-arm64] Missing required command: ${command}" >&2
    exit 1
  fi
done

read -r -a MAC_TARGET_ARRAY <<< "${MAC_TARGETS:-dmg zip}"
if [[ "${#MAC_TARGET_ARRAY[@]}" -eq 0 ]]; then
  echo "[build-macos-arm64] MAC_TARGETS must contain at least one electron-builder macOS target." >&2
  exit 1
fi

has_mac_target() {
  local target="$1"
  for candidate in "${MAC_TARGET_ARRAY[@]}"; do
    if [[ "${candidate}" == "${target}" ]]; then
      return 0
    fi
  done
  return 1
}

if has_mac_target "dmg"; then
  STALE_DMG_MOUNTS="$(hdiutil info | grep -F "${ELECTRON_OUTPUT_DIR}/.temp" || true)"
  if [[ -n "${STALE_DMG_MOUNTS}" ]]; then
    echo "[build-macos-arm64] Found stale Electron Builder temporary DMG mounts in this worktree:" >&2
    echo "${STALE_DMG_MOUNTS}" >&2
    echo "[build-macos-arm64] Detach the stale disk image or restart DiskImages before building the dmg target." >&2
    echo "[build-macos-arm64] To verify the update zip path without DMG, rerun with MAC_TARGETS=zip." >&2
    exit 1
  fi
fi

if [[ "${SKIP_INSTALL:-0}" != "1" ]]; then
  echo "[build-macos-arm64] Installing root dependencies..."
  (cd "${REPO_ROOT}" && bun install)

  echo "[build-macos-arm64] Installing desktop dependencies..."
  (cd "${DESKTOP_DIR}" && bun install)
fi

echo "[build-macos-arm64] Cleaning stale Electron outputs..."
rm -rf "${DESKTOP_DIR}/dist"
rm -rf "${DESKTOP_DIR}/electron-dist"
rm -rf "${ELECTRON_OUTPUT_DIR}"
rm -rf "${CANONICAL_OUTPUT_DIR}"
rm -f "${DESKTOP_DIR}/tsconfig.tsbuildinfo"
rm -rf "${DESKTOP_DIR}/src-tauri/binaries/claude-sidecar-"*

echo "[build-macos-arm64] Building sidecars for ${TARGET_TRIPLE}..."
(cd "${DESKTOP_DIR}" && SIDECAR_TARGET_TRIPLE="${TARGET_TRIPLE}" bun run build:sidecars)

echo "[build-macos-arm64] Building renderer and Electron main/preload bundles..."
(cd "${DESKTOP_DIR}" && bun run build:plugin-seed && bun run build && bun run build:electron)

if [[ "${REBUILD_NATIVE:-0}" == "1" ]]; then
  echo "[build-macos-arm64] Rebuilding native dependencies for Electron ABI..."
  (cd "${DESKTOP_DIR}" && node "${ELECTRON_BUILDER_CLI}" install-app-deps)
  (cd "${DESKTOP_DIR}" && bun run prepare:node-pty)
fi

echo "[build-macos-arm64] Cleaning empty dmg-builder cache directories..."
(cd "${DESKTOP_DIR}" && bash ./scripts/clean-dmg-builder-cache.sh)

BUILDER_ARGS=(node "${ELECTRON_BUILDER_CLI}" --mac "${MAC_TARGET_ARRAY[@]}" --arm64 --publish never)
if [[ "${SIGN_BUILD:-0}" != "1" ]]; then
  export CSC_IDENTITY_AUTO_DISCOVERY=false
  # package.json sets mac.notarize=true for the signed CI release path. A local
  # unsigned build has no Developer ID credentials, so explicitly disable
  # notarization here to keep `electron:package` working without an Apple account.
  BUILDER_ARGS+=(-c.mac.notarize=false)
fi
if [[ "$#" -gt 0 ]]; then
  BUILDER_ARGS+=("$@")
fi

echo "[build-macos-arm64] Packaging Electron app..."
(cd "${DESKTOP_DIR}" && "${BUILDER_ARGS[@]}")

mkdir -p "${CANONICAL_OUTPUT_DIR}"
find "${CANONICAL_OUTPUT_DIR}" -mindepth 1 -maxdepth 1 -exec rm -rf {} +

if [[ -d "${ELECTRON_OUTPUT_DIR}/mac-arm64" ]]; then
  find "${ELECTRON_OUTPUT_DIR}/mac-arm64" -maxdepth 1 -type d -name '*.app' -exec cp -R {} "${CANONICAL_OUTPUT_DIR}/" \;
fi
find "${ELECTRON_OUTPUT_DIR}" -maxdepth 1 -type f \( -name '*.dmg' -o -name '*.zip' -o -name '*.blockmap' -o -name 'latest-mac.yml' \) -exec cp -f {} "${CANONICAL_OUTPUT_DIR}/" \;

cat > "${CANONICAL_OUTPUT_DIR}/BUILD_INFO.txt" <<EOF
Target triple: ${TARGET_TRIPLE}
Builder output: ${ELECTRON_OUTPUT_DIR}
Canonical output: ${CANONICAL_OUTPUT_DIR}
Built at: $(date '+%Y-%m-%d %H:%M:%S %z')
EOF

if [[ "${SKIP_PACKAGE_SMOKE:-0}" != "1" ]]; then
  PACKAGE_SMOKE_ARGS=(bun run test:package-smoke --platform macos --package-kind release --artifacts-dir desktop/build-artifacts/macos-arm64)
  if [[ "${REQUIRE_MACOS_GATEKEEPER_SMOKE:-0}" == "1" ]]; then
    PACKAGE_SMOKE_ARGS+=(--require-macos-gatekeeper)
  fi
  echo "[build-macos-arm64] Running package smoke..."
  (cd "${REPO_ROOT}" && "${PACKAGE_SMOKE_ARGS[@]}")
fi

echo
echo "[build-macos-arm64] Build finished."
echo "[build-macos-arm64] Canonical output: ${CANONICAL_OUTPUT_DIR}"

if [[ "${OPEN_OUTPUT:-0}" == "1" ]]; then
  open "${CANONICAL_OUTPUT_DIR}"
fi
