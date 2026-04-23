#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DESKTOP_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${DESKTOP_DIR}/.." && pwd)"

TARGET_TRIPLE="aarch64-apple-darwin"
TAURI_TARGET_DIR="${DESKTOP_DIR}/src-tauri/target"
CANONICAL_OUTPUT_DIR="${DESKTOP_DIR}/build-artifacts/macos-arm64"
APP_BUNDLE_NAME="Claude Code Haha.app"
APP_BUNDLE_ID="com.claude-code-haha.desktop"

usage() {
  cat <<'EOF'
Build Claude Code Haha desktop for macOS Apple Silicon and output a DMG.

Usage:
  ./desktop/scripts/build-macos-arm64.sh [extra tauri build args...]

Environment:
  SKIP_INSTALL=1   Skip `bun install` in the repo root and desktop app.
  SIGN_BUILD=1     Remove the default `--no-sign` flag and allow signed builds.
  OPEN_OUTPUT=1    Open the canonical artifact output directory in Finder after a successful build.

Examples:
  ./desktop/scripts/build-macos-arm64.sh
  SKIP_INSTALL=1 ./desktop/scripts/build-macos-arm64.sh
  SIGN_BUILD=1 ./desktop/scripts/build-macos-arm64.sh --skip-stapling
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

for command in bun cargo rustc codesign hdiutil; do
  if ! command -v "${command}" >/dev/null 2>&1; then
    echo "[build-macos-arm64] Missing required command: ${command}" >&2
    exit 1
  fi
done

if [[ "${SKIP_INSTALL:-0}" != "1" ]]; then
  echo "[build-macos-arm64] Installing root dependencies..."
  (cd "${REPO_ROOT}" && bun install)

  echo "[build-macos-arm64] Installing desktop dependencies..."
  (cd "${DESKTOP_DIR}" && bun install)
fi

# ── 清理 + 显式预热前端 / sidecar ────────────────────────────
# 之前遇到过"改了 src/ 代码,build 的 .app 里 sidecar 还是旧的"的诡异
# case —— 根因是 Bun.build / Tauri bundler 某一层的缓存把旧 sidecar
# binary 复用进了新 .app(.app 被删干净了也救不回来,因为 binary 源在
# desktop/src-tauri/binaries/)。
#
# 这里做三件事强制 fresh build:
#   1) 硬删 sidecar 源 binary + Tauri bundle 目录 + 前端 dist
#   2) 显式跑 bun run build + bun run build:sidecars
#   3) tauri build 用 --config 覆盖 beforeBuildCommand 为 true(no-op),
#      避免 sidecar 被重复编译浪费 ~10s
# 任一步失败,整个脚本立即退出(set -e)。
echo "[build-macos-arm64] Cleaning stale sidecar binaries and bundle output..."
rm -rf "${DESKTOP_DIR}/src-tauri/binaries/claude-sidecar-"*
rm -rf "${DESKTOP_DIR}/src-tauri/target/${TARGET_TRIPLE}/release/bundle"
rm -rf "${DESKTOP_DIR}/src-tauri/target/release/bundle"
rm -rf "${DESKTOP_DIR}/dist"

echo "[build-macos-arm64] Rebuilding frontend (tsc + vite)..."
(cd "${DESKTOP_DIR}" && bun run build)

echo "[build-macos-arm64] Rebuilding sidecar for ${TARGET_TRIPLE}..."
(cd "${DESKTOP_DIR}" && TAURI_ENV_TARGET_TRIPLE="${TARGET_TRIPLE}" bun run build:sidecars)

TAURI_ARGS=(
  bunx
  tauri
  build
  --target
  "${TARGET_TRIPLE}"
  --bundles
  app,dmg
  --ci
  --config
  '{"build":{"beforeBuildCommand":"true"}}'
)

if [[ "${SIGN_BUILD:-0}" != "1" ]]; then
  TAURI_ARGS+=(--no-sign)
fi

if [[ "$#" -gt 0 ]]; then
  TAURI_ARGS+=("$@")
fi

echo "[build-macos-arm64] Building DMG for ${TARGET_TRIPLE}..."
(
  cd "${DESKTOP_DIR}"
  export TAURI_ENV_TARGET_TRIPLE="${TARGET_TRIPLE}"
  "${TAURI_ARGS[@]}"
)

TARGETED_DMG_DIR="${TAURI_TARGET_DIR}/${TARGET_TRIPLE}/release/bundle/dmg"
FALLBACK_DMG_DIR="${TAURI_TARGET_DIR}/release/bundle/dmg"
TARGETED_APP_DIR="${TAURI_TARGET_DIR}/${TARGET_TRIPLE}/release/bundle/macos"
FALLBACK_APP_DIR="${TAURI_TARGET_DIR}/release/bundle/macos"
LEGACY_BUNDLE_ROOT="${TAURI_TARGET_DIR}/release/bundle"

mkdir -p "${CANONICAL_OUTPUT_DIR}"
find "${CANONICAL_OUTPUT_DIR}" -mindepth 1 -maxdepth 1 -exec rm -rf {} +

find_latest_file() {
  local search_dir="$1"
  local pattern="$2"
  if [[ -d "${search_dir}" ]]; then
    find "${search_dir}" -maxdepth 1 -type f -name "${pattern}" | sort | tail -n 1
  fi
}

find_latest_dir() {
  local search_dir="$1"
  local pattern="$2"
  if [[ -d "${search_dir}" ]]; then
    find "${search_dir}" -maxdepth 1 -type d -name "${pattern}" | sort | tail -n 1
  fi
}

LATEST_DMG="$(find_latest_file "${TARGETED_DMG_DIR}" '*.dmg')"
if [[ -z "${LATEST_DMG}" ]]; then
  LATEST_DMG="$(find_latest_file "${FALLBACK_DMG_DIR}" '*.dmg')"
fi

LATEST_APP="$(find_latest_dir "${TARGETED_APP_DIR}" '*.app')"
if [[ -z "${LATEST_APP}" ]]; then
  LATEST_APP="$(find_latest_dir "${FALLBACK_APP_DIR}" '*.app')"
fi

build_canonical_dmg() {
  local app_bundle="$1"
  local dmg_output="$2"
  local staging_dir
  local rw_dmg

  staging_dir="$(mktemp -d "${TMPDIR:-/tmp}/cc-haha-dmg.XXXXXX")"
  rw_dmg="$(mktemp "${TMPDIR:-/tmp}/cc-haha-rw.XXXXXX").dmg"

  cp -R "${app_bundle}" "${staging_dir}/"
  ln -s /Applications "${staging_dir}/Applications"

  # Create a read-write DMG first so we can customize the Finder layout
  hdiutil create \
    -volname "Claude Code Haha" \
    -srcfolder "${staging_dir}" \
    -ov \
    -format UDRW \
    "${rw_dmg}" >/dev/null

  rm -rf "${staging_dir}"

  # Mount the read-write DMG and apply Finder layout via AppleScript
  local dev_name mount_dir
  dev_name=$(hdiutil attach -readwrite -noverify -noautoopen -nobrowse "${rw_dmg}" \
    | grep -E '^/dev/' | head -1 | awk '{print $1}')
  mount_dir=$(hdiutil info | grep -E "${dev_name}" | tail -1 | awk '{$1=$2=""; print}' | xargs)

  # Finder AppleScript 在新版 macOS (Sequoia+) 上某些属性
  # (toolbar/statusbar visible、某些 container window 属性) 不再支持,
  # 会返回 -10006 错误。美化失败不是 blocker —— 即便 layout 没设上,
  # DMG 本身还是可用的,只是用户打开时看到的是 Finder 默认排布。
  # 所以这里允许 osascript 非零退出,只 warn,不让 set -e 炸掉整个脚本。
  if ! osascript <<APPLESCRIPT
tell application "Finder"
  tell disk "Claude Code Haha"
    open
    set current view of container window to icon view
    set toolbar visible of container window to false
    set statusbar visible of container window to false
    set the bounds of container window to {100, 100, 760, 500}
    set viewOptions to the icon view options of container window
    set arrangement of viewOptions to not arranged
    set icon size of viewOptions to 128
    set position of item "${APP_BUNDLE_NAME}" of container window to {180, 170}
    set position of item "Applications" of container window to {480, 170}
    close
    open
    update without registering applications
    delay 2
    close
  end tell
end tell
APPLESCRIPT
  then
    echo "[build-macos-arm64] WARN: Finder layout AppleScript failed (likely macOS version incompatible); DMG will use default Finder layout" >&2
  fi

  sync
  # osascript 可能已经让 Finder 打开了 volume 窗口,正常 detach 可能因为
  # "Resource busy" 失败。失败时用 -force 二次尝试。
  hdiutil detach "${dev_name}" -quiet 2>/dev/null \
    || hdiutil detach "${dev_name}" -force -quiet

  # Convert to compressed read-only DMG
  hdiutil convert "${rw_dmg}" -format UDZO -o "${dmg_output}" -ov >/dev/null
  rm -f "${rw_dmg}"
}

if [[ -n "${LATEST_DMG}" ]]; then
  cp -f "${LATEST_DMG}" "${CANONICAL_OUTPUT_DIR}/"
fi

if [[ -n "${LATEST_APP}" ]]; then
  # 注意: 不要再对 .app 重签名。曾经脚本在这里跑过
  # `codesign --force --deep --sign - --identifier <bundle-id>` 来统一
  # sidecar 和外层的 signing identifier,但这会改变 sidecar binary 的
  # code signature hash —— macOS Keychain ACL 按 hash 识别 caller,
  # 重签完再访问时会被 ACL 当作"陌生 binary"静默拒绝,导致 CLI 读不到
  # OAuth token,最终请求打到 Anthropic 返回 403 "Request not allowed"。
  # Tauri 的 --no-sign 其实已经做了 ad-hoc 签名,直接用即可。
  cp -R "${LATEST_APP}" "${CANONICAL_OUTPUT_DIR}/"
  rm -f "${CANONICAL_OUTPUT_DIR}/"*.dmg
  build_canonical_dmg \
    "${CANONICAL_OUTPUT_DIR}/${APP_BUNDLE_NAME}" \
    "${CANONICAL_OUTPUT_DIR}/$(basename "${LATEST_DMG:-Claude Code Haha_0.1.0_aarch64.dmg}")"
fi

cat > "${CANONICAL_OUTPUT_DIR}/BUILD_INFO.txt" <<EOF
Target triple: ${TARGET_TRIPLE}
Canonical output: ${CANONICAL_OUTPUT_DIR}
Source DMG: ${LATEST_DMG:-not found}
Source app: ${LATEST_APP:-not found}
Built at: $(date '+%Y-%m-%d %H:%M:%S %z')
EOF

if [[ -d "${LEGACY_BUNDLE_ROOT}" ]]; then
  rm -rf "${LEGACY_BUNDLE_ROOT}"
fi

echo
echo "[build-macos-arm64] Build finished."
if [[ -n "${LATEST_DMG}" ]]; then
  echo "[build-macos-arm64] DMG source: ${LATEST_DMG}"
else
  echo "[build-macos-arm64] No DMG found in ${TARGETED_DMG_DIR} or ${FALLBACK_DMG_DIR}" >&2
fi

if [[ -n "${LATEST_APP}" ]]; then
  echo "[build-macos-arm64] App source: ${LATEST_APP}"
else
  echo "[build-macos-arm64] No .app found in ${TARGETED_APP_DIR} or ${FALLBACK_APP_DIR}" >&2
fi

echo "[build-macos-arm64] Canonical output: ${CANONICAL_OUTPUT_DIR}"
echo "[build-macos-arm64] Removed legacy bundle dir: ${LEGACY_BUNDLE_ROOT}"

if [[ "${OPEN_OUTPUT:-0}" == "1" ]]; then
  open "${CANONICAL_OUTPUT_DIR}"
fi
