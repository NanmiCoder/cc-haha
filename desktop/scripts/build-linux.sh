#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DESKTOP_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${DESKTOP_DIR}/.." && pwd)"

LINUX_ARCH="${LINUX_ARCH:-x64}"
case "${LINUX_ARCH}" in
  x64)
    TARGET_TRIPLE="x86_64-unknown-linux-gnu"
    BUILDER_ARCH="x64"
    CANONICAL_ARCH="linux-x64"
    ;;
  arm64)
    TARGET_TRIPLE="aarch64-unknown-linux-gnu"
    BUILDER_ARCH="arm64"
    CANONICAL_ARCH="linux-arm64"
    ;;
  *)
    echo "[build-linux] Unsupported LINUX_ARCH=${LINUX_ARCH}. Expected x64 or arm64." >&2
    exit 1
    ;;
esac

CANONICAL_OUTPUT_DIR="${DESKTOP_DIR}/build-artifacts/${CANONICAL_ARCH}"
ELECTRON_OUTPUT_DIR="${DESKTOP_DIR}/build-artifacts/electron"

usage() {
  cat <<'EOF'
Build Claude Code Haha desktop for Linux with Electron Builder.

Usage:
  ./desktop/scripts/build-linux.sh [extra electron-builder args...]

Environment:
  LINUX_ARCH=x64|arm64  Target architecture. Defaults to x64.
  LINUX_TARGETS         Electron Builder Linux targets. Defaults to "AppImage deb".
  SKIP_INSTALL=1        Skip `bun install` in the repo root and desktop app.
  REBUILD_NATIVE=1      Run `electron-builder install-app-deps` before packaging.
  SKIP_PACKAGE_SMOKE=1  Skip package-smoke verification after copying artifacts.
  OPEN_OUTPUT=1         Open the canonical artifact output directory after a successful build.
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "[build-linux] This script must run on Linux." >&2
  exit 1
fi

for command in bun; do
  if ! command -v "${command}" >/dev/null 2>&1; then
    echo "[build-linux] Missing required command: ${command}" >&2
    exit 1
  fi
done

read -r -a LINUX_TARGET_ARRAY <<< "${LINUX_TARGETS:-AppImage deb}"
if [[ "${#LINUX_TARGET_ARRAY[@]}" -eq 0 ]]; then
  echo "[build-linux] LINUX_TARGETS must contain at least one electron-builder Linux target." >&2
  exit 1
fi

if [[ "${SKIP_INSTALL:-0}" != "1" ]]; then
  echo "[build-linux] Installing root dependencies..."
  (cd "${REPO_ROOT}" && bun install)

  echo "[build-linux] Installing desktop dependencies..."
  (cd "${DESKTOP_DIR}" && bun install)
fi

echo "[build-linux] Cleaning stale Electron outputs..."
rm -rf "${DESKTOP_DIR}/dist"
rm -rf "${DESKTOP_DIR}/electron-dist"
rm -rf "${ELECTRON_OUTPUT_DIR}"
rm -rf "${CANONICAL_OUTPUT_DIR}"
rm -f "${DESKTOP_DIR}/tsconfig.tsbuildinfo"
rm -rf "${DESKTOP_DIR}/src-tauri/binaries/claude-sidecar-"*

echo "[build-linux] Building sidecars for ${TARGET_TRIPLE}..."
(cd "${DESKTOP_DIR}" && SIDECAR_TARGET_TRIPLE="${TARGET_TRIPLE}" bun run build:sidecars)

echo "[build-linux] Building renderer and Electron main/preload bundles..."
(cd "${DESKTOP_DIR}" && bun run build:plugin-seed && bun run build && bun run build:electron)

if [[ "${REBUILD_NATIVE:-0}" == "1" ]]; then
  echo "[build-linux] Rebuilding native dependencies for Electron ABI..."
  (cd "${DESKTOP_DIR}" && bunx electron-builder install-app-deps)
  (cd "${DESKTOP_DIR}" && bun run prepare:node-pty)
fi

BUILDER_ARGS=(bunx electron-builder --linux "${LINUX_TARGET_ARRAY[@]}" "--${BUILDER_ARCH}" --publish never)
if [[ "$#" -gt 0 ]]; then
  BUILDER_ARGS+=("$@")
fi

echo "[build-linux] Packaging Electron app..."
(cd "${DESKTOP_DIR}" && "${BUILDER_ARGS[@]}")

mkdir -p "${CANONICAL_OUTPUT_DIR}"
find "${CANONICAL_OUTPUT_DIR}" -mindepth 1 -maxdepth 1 -exec rm -rf {} +

if [[ -d "${ELECTRON_OUTPUT_DIR}/linux-unpacked" ]]; then
  cp -R "${ELECTRON_OUTPUT_DIR}/linux-unpacked" "${CANONICAL_OUTPUT_DIR}/"
else
  echo "[build-linux] Warning: linux-unpacked was not found under ${ELECTRON_OUTPUT_DIR}; package-smoke will only inspect packaged artifacts." >&2
fi

find "${ELECTRON_OUTPUT_DIR}" -maxdepth 1 -type f \( -name '*.AppImage' -o -name '*.deb' -o -name '*.blockmap' -o -name 'latest-linux*.yml' \) -exec cp -f {} "${CANONICAL_OUTPUT_DIR}/" \;

cat > "${CANONICAL_OUTPUT_DIR}/BUILD_INFO.txt" <<EOF
Target triple: ${TARGET_TRIPLE}
Linux arch: ${LINUX_ARCH}
Builder output: ${ELECTRON_OUTPUT_DIR}
Canonical output: ${CANONICAL_OUTPUT_DIR}
Built at: $(date '+%Y-%m-%d %H:%M:%S %z')
EOF

if [[ "${SKIP_PACKAGE_SMOKE:-0}" != "1" ]]; then
  echo "[build-linux] Running package smoke..."
  (cd "${REPO_ROOT}" && bun run test:package-smoke --platform linux --package-kind release --artifacts-dir "desktop/build-artifacts/${CANONICAL_ARCH}")
fi

echo
echo "[build-linux] Build finished."
echo "[build-linux] Canonical output: ${CANONICAL_OUTPUT_DIR}"

if [[ "${OPEN_OUTPUT:-0}" == "1" && -n "$(command -v xdg-open || true)" ]]; then
  xdg-open "${CANONICAL_OUTPUT_DIR}" >/dev/null 2>&1 || true
fi
