#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DESKTOP_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${DESKTOP_DIR}/.." && pwd)"
ADAPTERS_DIR="${REPO_ROOT}/adapters"

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
  SKIP_INSTALL=1   Skip `bun install` in the repo root, desktop app, and adapters package.
  SIGN_BUILD=0     Force an unsigned (ad-hoc) build. Signing is ON by default
                   when a stable identity exists in the keychain, because
                   Computer Use requires host + sidecar + helper to share one
                   certificate. An ad-hoc build cannot use Computer Use.
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

echo "[build-macos-arm64] Checking that packaged output is not running..."
(cd "${DESKTOP_DIR}" && bun run ./scripts/assert-electron-output-idle.ts "${ELECTRON_OUTPUT_DIR}" "${CANONICAL_OUTPUT_DIR}")

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

  echo "[build-macos-arm64] Installing adapter dependencies..."
  (cd "${ADAPTERS_DIR}" && bun install)
fi

echo "[build-macos-arm64] Cleaning stale Electron outputs..."
(cd "${DESKTOP_DIR}" && bun run ./scripts/assert-electron-output-idle.ts "${ELECTRON_OUTPUT_DIR}" "${CANONICAL_OUTPUT_DIR}")
(cd "${DESKTOP_DIR}" && bun run ./scripts/clean-electron-output.ts)
rm -rf "${DESKTOP_DIR}/dist"
rm -rf "${DESKTOP_DIR}/electron-dist"
rm -rf "${CANONICAL_OUTPUT_DIR}"
rm -f "${DESKTOP_DIR}/tsconfig.tsbuildinfo"
rm -rf "${DESKTOP_DIR}/src-tauri/binaries/claude-sidecar-"*

# ---------------------------------------------------------------------------
# Resolve ONE signing identity for the entire build, before anything is signed.
#
# Computer Use's native helper only accepts calls from a process chain it can
# cryptographically tie to this app (ClientAttestation.swift): the host, the
# sidecar and the helper must all carry the SAME certificate — same team, same
# leaf. Three different build steps sign those three binaries, so the identity
# has to be decided here, up front, and handed to all of them.
#
# An ad-hoc build has no certificate at all, so Computer Use fails closed on it.
# That is why signing is the default and SIGN_BUILD=0 is the explicit opt-out.
#
# Preference order mirrors resolveStableSigningIdentity() in
# desktop/scripts/sign-identity.ts: Developer ID first (long-lived; TCC grants
# are keyed to the identity, and an Apple Development cert expires yearly).
# ---------------------------------------------------------------------------
SIGN_BUILD_EFFECTIVE="${SIGN_BUILD:-}"
RESOLVED_SIGN_IDENTITY="${CC_HAHA_SIGN_IDENTITY:-}"

if [[ -z "${RESOLVED_SIGN_IDENTITY}" && "${SIGN_BUILD_EFFECTIVE}" != "0" ]]; then
  RESOLVED_SIGN_IDENTITY="$(
    security find-identity -v -p codesigning 2>/dev/null \
      | grep -E '"Developer ID Application:' \
      | head -1 \
      | sed -E 's/^[^"]*"([^"]+)".*$/\1/'
  )"
  if [[ -z "${RESOLVED_SIGN_IDENTITY}" ]]; then
    RESOLVED_SIGN_IDENTITY="$(
      security find-identity -v -p codesigning 2>/dev/null \
        | grep -E '"Apple Development:' \
        | head -1 \
        | sed -E 's/^[^"]*"([^"]+)".*$/\1/'
    )"
  fi
fi

if [[ "${SIGN_BUILD_EFFECTIVE}" == "0" || -z "${RESOLVED_SIGN_IDENTITY}" ]]; then
  SIGN_BUILD_EFFECTIVE=0
  if [[ "${SIGN_BUILD:-}" == "0" ]]; then
    echo "[build-macos-arm64] SIGN_BUILD=0 — building ad-hoc by request."
  else
    echo "[build-macos-arm64] No stable signing identity in the keychain — building ad-hoc."
  fi
  echo "[build-macos-arm64] NOTE: Computer Use does not work on an ad-hoc build."
else
  SIGN_BUILD_EFFECTIVE=1
  # Every signing step reads one of these: build-sidecars.ts and
  # native/cu-helper/build.sh read CC_HAHA_SIGN_IDENTITY, electron-builder reads
  # CSC_NAME. Pinning CSC_NAME rather than leaving auto-discovery on is what
  # guarantees the host lands on the same cert as the other two.
  export CC_HAHA_SIGN_IDENTITY="${RESOLVED_SIGN_IDENTITY}"
  # electron-builder rejects a CSC_NAME carrying the certificate-type prefix
  # ("Please remove prefix \"Developer ID Application:\" …") — it wants only the
  # common name and picks the certificate type itself. `codesign --sign` on the
  # other hand matches on any unique substring, so the stripped name still
  # resolves to the exact same certificate for the sidecar and the helper.
  export CSC_NAME="${RESOLVED_SIGN_IDENTITY#Developer ID Application: }"
  CSC_NAME="${CSC_NAME#Apple Development: }"
  export CSC_NAME
  echo "[build-macos-arm64] Signing identity: ${RESOLVED_SIGN_IDENTITY}"
  echo "[build-macos-arm64] (set SIGN_BUILD=0 to build ad-hoc instead)"
fi

echo "[build-macos-arm64] Building sidecars for ${TARGET_TRIPLE}..."
(cd "${DESKTOP_DIR}" && SIDECAR_TARGET_TRIPLE="${TARGET_TRIPLE}" bun run prepare:cloudflared)
(cd "${DESKTOP_DIR}" && SIDECAR_TARGET_TRIPLE="${TARGET_TRIPLE}" bun run build:sidecars)

echo "[build-macos-arm64] Building renderer and Electron main/preload bundles..."
(cd "${DESKTOP_DIR}" && bun run build && bun run build:electron)

if [[ "${REBUILD_NATIVE:-0}" == "1" ]]; then
  echo "[build-macos-arm64] Rebuilding native dependencies for Electron ABI..."
  (cd "${DESKTOP_DIR}" && node "${ELECTRON_BUILDER_CLI}" install-app-deps)
  (cd "${DESKTOP_DIR}" && bun run prepare:node-pty)
fi

echo "[build-macos-arm64] Cleaning empty dmg-builder cache directories..."
(cd "${DESKTOP_DIR}" && bash ./scripts/clean-dmg-builder-cache.sh)

BUILDER_ARGS=(node "${ELECTRON_BUILDER_CLI}" --mac "${MAC_TARGET_ARRAY[@]}" --arm64 --publish never)

# The identity was resolved (and exported as CSC_NAME) before the sidecars were
# built, so electron-builder only needs the unsigned-build opt-out here.
if [[ "${SIGN_BUILD_EFFECTIVE}" != "1" ]]; then
  export CSC_IDENTITY_AUTO_DISCOVERY=false
fi

# Notarization stays OFF for local builds regardless of signing: it needs an
# Apple ID + app-specific password and a round-trip through Apple's queue.
# package.json keeps mac.notarize=true for CI's release path.
BUILDER_ARGS+=(-c.mac.notarize=false)
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
  PACKAGE_SMOKE_ARGS=(bun run test:package-smoke --platform macos --arch arm64 --package-kind release --artifacts-dir desktop/build-artifacts/macos-arm64)
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
