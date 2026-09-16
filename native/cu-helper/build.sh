#!/usr/bin/env bash
#
# build.sh — Build + STABLE-identity codesign for the `cu-helper` Computer Use helper.
#
# Usage: ./build.sh
#
# Env overrides:
#   CU_HELPER_IDENTITY   (default: auto -> 'Apple Development: ...' if found, else 'cu-helper-dev')
#   CU_HELPER_BUNDLE_ID  (default: dev.cchaha.cu-helper)  # constant => stable TCC row
#   CU_HELPER_ARCH       (default: current machine arch; arm64 or x86_64)
#   CU_HELPER_TIMESTAMP_MODE
#                        (default: auto; secure for Developer ID, none for local development)
#
# Output: prints "built: <arch-specific abs path>/cc-haha-computer-use.app"
#
# Stable-identity contract: same cert + same --identifier on every build,
# --options runtime, a secure timestamp for Developer ID distribution, no ad-hoc.
#
# WHY this matters: macOS TCC (Privacy & Security) grants Accessibility + Screen
# Recording to a binary keyed by its code-signing identity (the "designated
# requirement" / cdhash lineage). An ad-hoc signature (codesign -s -) or a
# per-build throwaway cert rotates that identity on EVERY rebuild, so the user
# would have to re-grant both permissions after every `swift build`. To keep the
# grants alive we ALWAYS sign with a STABLE cert and a CONSTANT --identifier.
# We NEVER fall back to ad-hoc signing — if no stable identity exists we stop and
# tell the user exactly how to create a one-time self-signed Code Signing cert.

set -euo pipefail

# ---------------------------------------------------------------------------
# 0. Resolve paths (absolute, independent of caller CWD).
# ---------------------------------------------------------------------------

# Directory containing THIS script == the SwiftPM package root (has Package.swift).
SCRIPT_SOURCE="${BASH_SOURCE[0]}"
# Resolve symlinks to this script so PKG_DIR is the real package directory.
while [ -h "$SCRIPT_SOURCE" ]; do
  link_dir="$(cd -P "$(dirname "$SCRIPT_SOURCE")" >/dev/null 2>&1 && pwd)"
  SCRIPT_SOURCE="$(readlink "$SCRIPT_SOURCE")"
  case "$SCRIPT_SOURCE" in
    /*) ;;                                  # already absolute
    *) SCRIPT_SOURCE="$link_dir/$SCRIPT_SOURCE" ;;  # make relative link absolute
  esac
done
PKG_DIR="$(cd -P "$(dirname "$SCRIPT_SOURCE")" >/dev/null 2>&1 && pwd)"

BUILD_CONFIG="release"
BUILD_DIR="$PKG_DIR/.build"
# Reuse the desktop brand asset so both Privacy lists show the product logo.
APP_ICON_PATH="$PKG_DIR/../../desktop/src-tauri/icons/icon.icns"

BUNDLE_ID="${CU_HELPER_BUNDLE_ID:-dev.cchaha.cu-helper}"
ARCH="${CU_HELPER_ARCH:-$(uname -m)}"
SWIFT_SCRATCH_PATH="$BUILD_DIR/$ARCH"
BIN_DIR=""
BIN_PATH=""
APP_PATH=""
RESOURCE_BUNDLE_PATH=""
# Records the (identity, identifier) actually used, so we can detect rotation
# across rebuilds and warn that TCC grants will have been dropped.
SIGN_STAMP="$BUILD_DIR/.cu-helper.$ARCH.signid"

# ---------------------------------------------------------------------------
# Logging helpers — everything diagnostic goes to STDERR so the final
# machine-readable "built: <path>" line on STDOUT stays clean for any caller
# that parses it.
# ---------------------------------------------------------------------------
log()  { printf '%s\n' "$*" >&2; }
err()  { printf 'error: %s\n' "$*" >&2; }
die()  { err "$*"; exit 1; }

# ---------------------------------------------------------------------------
# 1. Preflight — toolchain + platform.
# ---------------------------------------------------------------------------
preflight() {
  if [ "$(uname -s)" != "Darwin" ]; then
    die "cu-helper builds only on macOS (got $(uname -s)). ScreenCaptureKit + AppKit are macOS-only."
  fi

  command -v swift   >/dev/null 2>&1 || die "swift not found on PATH. Install Xcode / Command Line Tools."
  command -v lipo    >/dev/null 2>&1 || die "lipo not found on PATH. Install Xcode / Command Line Tools."
  command -v codesign >/dev/null 2>&1 || die "codesign not found on PATH. Install Xcode / Command Line Tools."
  command -v security >/dev/null 2>&1 || die "security tool not found on PATH (needed to enumerate signing identities)."

  [ -f "$PKG_DIR/Package.swift" ] || die "Package.swift not found in $PKG_DIR — is this the cu-helper package root?"
  case "$ARCH" in
    arm64|x86_64) ;;
    *) die "unsupported CU_HELPER_ARCH='$ARCH' (expected arm64 or x86_64)" ;;
  esac

  log "swift:   $(swift --version 2>&1 | head -1)"
  log "package: $PKG_DIR"
  log "host:    $(sw_vers -productName 2>/dev/null || echo macOS) $(sw_vers -productVersion 2>/dev/null) ($(uname -m))"
}

# ---------------------------------------------------------------------------
# 2. Resolve a STABLE signing identity.
#
#    Priority:
#      a) $CC_HAHA_SIGN_IDENTITY (shared host/sidecar/helper build identity)
#      b) $CU_HELPER_IDENTITY (legacy helper-only override for direct builds)
#      c) the first 'Developer ID Application: ...' identity (release/CI)
#      d) the first real 'Apple Development: ...' identity in the keychain
#      e) a self-signed 'cu-helper-dev' identity if one exists
#      f) NONE -> print one-time create instructions and FAIL (never ad-hoc).
#
#    Sets globals: SIGN_IDENTITY (string passed to codesign --sign)
# ---------------------------------------------------------------------------
SIGN_IDENTITY=""

# Self-signed fallback cert name (a Code Signing cert the user creates ONCE).
SELF_SIGNED_NAME="cu-helper-dev"

# Returns 0 if a codesigning identity whose name contains $1 exists.
identity_exists() {
  local needle="$1"
  security find-identity -v -p codesigning 2>/dev/null | grep -F "$needle" >/dev/null 2>&1
}

# Echoes the first 'Apple Development: ...' identity's full common name, or "".
first_apple_development_identity() {
  # Lines look like:  1) <40-hex-sha> "Apple Development: name (TEAMID)"
  # Extract the quoted common name of the first Apple Development row.
  security find-identity -v -p codesigning 2>/dev/null \
    | grep 'Apple Development:' \
    | head -1 \
    | sed -E 's/^[^"]*"([^"]+)".*$/\1/'
}

# Echoes the first Developer ID Application identity's full common name, or "".
first_developer_id_application_identity() {
  security find-identity -v -p codesigning 2>/dev/null \
    | grep 'Developer ID Application:' \
    | head -1 \
    | sed -E 's/^[^"]*"([^"]+)".*$/\1/'
}

print_self_signed_instructions() {
  cat >&2 <<EOF

------------------------------------------------------------------------------
No STABLE code-signing identity was found, and ad-hoc signing is intentionally
disabled (it rotates the binary's identity on every build and drops the user's
Accessibility + Screen Recording grants each rebuild).

Pick ONE of the following ONE-TIME setups, then re-run ./build.sh:

  OPTION A — Use your Apple Development certificate (recommended if you have a
  paid or free Apple developer account in Xcode):
      Xcode ▸ Settings ▸ Accounts ▸ (your Apple ID) ▸ Manage Certificates ▸
      '+' ▸ "Apple Development".
    Then this script auto-detects it; or pin it explicitly:
      export CU_HELPER_IDENTITY="Apple Development: you@example.com (TEAMID)"

  OPTION B — Create a self-signed Code Signing certificate named '$SELF_SIGNED_NAME'
  (no Apple account needed; perfect for local dev). In Keychain Access:
      1. Keychain Access ▸ menu "Certificate Assistant" ▸
         "Create a Certificate…"
      2. Name:                 $SELF_SIGNED_NAME
         Identity Type:        Self Signed Root
         Certificate Type:     Code Signing
         (leave "Let me override defaults" unchecked)
      3. Create, then keep it in the 'login' keychain and trust it for code
         signing if prompted.
    This script will then auto-detect '$SELF_SIGNED_NAME'.

  (CLI alternative for OPTION B — non-interactive cert creation is not reliably
   scriptable across macOS releases, so the Keychain Access UI above is the
   supported path.)

Why not ad-hoc? An ad-hoc signature has no stable designated requirement, so
macOS treats each rebuilt binary as a brand-new app and forgets every TCC grant.
A stable cert + constant --identifier ($BUNDLE_ID) keeps the grants alive across
rebuilds.
------------------------------------------------------------------------------
EOF
}

resolve_identity() {
  # a) shared build-wide override. The helper, the sidecar and the Electron host
  #     must end up on ONE certificate or the helper's client attestation rejects
  #     every call (see desktop/scripts/sign-identity.ts). It deliberately wins
  #     over the legacy helper-only variable so stale shell state cannot split a
  #     signed app across two certificates.
  if [ -n "${CC_HAHA_SIGN_IDENTITY:-}" ]; then
    SIGN_IDENTITY="$CC_HAHA_SIGN_IDENTITY"
    if [ "$SIGN_IDENTITY" = "-" ]; then
      die "CC_HAHA_SIGN_IDENTITY='-' (ad-hoc) is refused. Ad-hoc signing rotates the TCC identity every build. Use a stable cert."
    fi
    log "identity: $SIGN_IDENTITY (from CC_HAHA_SIGN_IDENTITY)"
    return 0
  fi

  # b) legacy explicit helper-only override for direct build.sh use.
  if [ -n "${CU_HELPER_IDENTITY:-}" ]; then
    SIGN_IDENTITY="$CU_HELPER_IDENTITY"
    # Best-effort sanity check; do not hard-fail on an override the user insists on,
    # but warn loudly if the keychain doesn't seem to contain it.
    if [ "$SIGN_IDENTITY" != "-" ] && ! identity_exists "$SIGN_IDENTITY"; then
      log "warning: CU_HELPER_IDENTITY='$SIGN_IDENTITY' was not found by 'security find-identity -v -p codesigning'."
      log "         Proceeding because it was explicitly provided; codesign will fail if it is truly missing."
    fi
    if [ "$SIGN_IDENTITY" = "-" ]; then
      die "CU_HELPER_IDENTITY='-' (ad-hoc) is refused. Ad-hoc signing rotates the TCC identity every build. Use a stable cert."
    fi
    log "identity: $SIGN_IDENTITY (from CU_HELPER_IDENTITY)"
    return 0
  fi

  # c) Developer ID distribution identity — PREFERRED. It is long-lived and
  #    notarizable, and TCC grants are keyed to the signing identity: an
  #    Apple Development cert expires in about a year and its replacement
  #    silently drops the user's Accessibility + Screen Recording grants.
  #    Order must match resolveStableSigningIdentity() in
  #    desktop/scripts/sign-identity.ts, or the helper and the sidecar land on
  #    different certs and attestation fails closed.
  local developer_id
  developer_id="$(first_developer_id_application_identity || true)"
  if [ -n "$developer_id" ]; then
    SIGN_IDENTITY="$developer_id"
    log "identity: $SIGN_IDENTITY (auto-detected Developer ID Application)"
    return 0
  fi

  # d) real Apple Development identity.
  local apple_dev
  apple_dev="$(first_apple_development_identity || true)"
  if [ -n "$apple_dev" ]; then
    SIGN_IDENTITY="$apple_dev"
    log "identity: $SIGN_IDENTITY (auto-detected Apple Development)"
    return 0
  fi

  # e) self-signed fallback cert.
  if identity_exists "$SELF_SIGNED_NAME"; then
    SIGN_IDENTITY="$SELF_SIGNED_NAME"
    log "identity: $SIGN_IDENTITY (auto-detected self-signed Code Signing cert)"
    return 0
  fi

  # f) nothing usable -> instructions + fail. NEVER ad-hoc.
  print_self_signed_instructions
  die "no stable code-signing identity available (refusing to ad-hoc sign)."
}

# ---------------------------------------------------------------------------
# 3. Resolve timestamp policy.
#
# Apple requires every Developer ID executable submitted for notarization to
# carry a secure timestamp. The helper is intentionally excluded from
# electron-builder re-signing, so this build is the ONLY place that can add it.
# Local Apple Development/self-signed builds stay offline by default.
# ---------------------------------------------------------------------------
CODESIGN_TIMESTAMP_ARG="--timestamp=none"
RESOLVED_TIMESTAMP_MODE="none"

resolve_timestamp_mode() {
  local requested="${CU_HELPER_TIMESTAMP_MODE:-auto}"
  case "$requested" in
    secure)
      RESOLVED_TIMESTAMP_MODE="secure"
      ;;
    none)
      RESOLVED_TIMESTAMP_MODE="none"
      ;;
    auto)
      local identity_name="$SIGN_IDENTITY"
      case "$identity_name" in
        "Developer ID Application:"*) ;;
        *)
          # Explicit identities may be supplied as a SHA-1 hash. Resolve the
          # matching common name when possible so auto mode still recognizes a
          # Developer ID certificate.
          local identity_row
          identity_row="$(security find-identity -v -p codesigning 2>/dev/null | grep -F "$SIGN_IDENTITY" | head -1 || true)"
          if [ -n "$identity_row" ]; then
            identity_name="$(printf '%s\n' "$identity_row" | sed -E 's/^[^"]*"([^"]+)".*$/\1/')"
          fi
          ;;
      esac
      case "$identity_name" in
        "Developer ID Application:"*) RESOLVED_TIMESTAMP_MODE="secure" ;;
        *) RESOLVED_TIMESTAMP_MODE="none" ;;
      esac
      ;;
    *)
      die "unsupported CU_HELPER_TIMESTAMP_MODE='$requested' (expected auto, secure, or none)"
      ;;
  esac

  if [ "$RESOLVED_TIMESTAMP_MODE" = "secure" ]; then
    CODESIGN_TIMESTAMP_ARG="--timestamp"
  else
    CODESIGN_TIMESTAMP_ARG="--timestamp=none"
  fi
}

# ---------------------------------------------------------------------------
# 4. Build (release, requested target architecture).
# ---------------------------------------------------------------------------
resolve_build_paths() {
  # `.build/release` is a mutable SwiftPM convenience symlink. It can point at
  # the host architecture after a cross-build, so resolve the bin directory
  # with the exact target arguments and keep each architecture in its own
  # scratch tree.
  BIN_DIR="$(swift build \
    -c "$BUILD_CONFIG" \
    --arch "$ARCH" \
    --package-path "$PKG_DIR" \
    --scratch-path "$SWIFT_SCRATCH_PATH" \
    --show-bin-path)"
  [ -n "$BIN_DIR" ] || die "swift build --show-bin-path returned an empty path for $ARCH"
  BIN_PATH="$BIN_DIR/cc-haha-computer-use"
  APP_PATH="$BIN_DIR/cc-haha-computer-use.app"
  RESOURCE_BUNDLE_PATH="$BIN_DIR/cu-helper_cc-haha-computer-use.bundle"
}

build() {
  log ""
  log "==> swift build -c $BUILD_CONFIG --arch $ARCH (+embed Info.plist)"
  # --package-path keeps us CWD-independent. Stderr from the compiler is already
  # informational; let it flow to our stderr (not stdout).
  #
  # -sectcreate __TEXT __info_plist <Info.plist>: embed an Info.plist into the
  # bare Mach-O at LINK time. TCC needs it (NSScreenCaptureUsageDescription +
  # constant CFBundleIdentifier) so cu-helper is a stable, distinct subject for
  # Screen Recording. Done here (not in Package.swift) so the path is an absolute
  # build-time value, not a hardcoded machine path in the manifest. The section
  # is created before sign() runs, so the signature seals it.
  resolve_build_paths
  swift build \
    -c "$BUILD_CONFIG" \
    --arch "$ARCH" \
    --package-path "$PKG_DIR" \
    --scratch-path "$SWIFT_SCRATCH_PATH" \
    -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker "$PKG_DIR/Info.plist" 1>&2

  [ -x "$BIN_PATH" ] || die "expected product not found or not executable at: $BIN_PATH"
  if ! lipo "$BIN_PATH" -verify_arch "$ARCH" 1>&2; then
    die "built product at $BIN_PATH does not contain required architecture $ARCH"
  fi
  log "verified architecture: $ARCH"

  # Hard assertion: the Info.plist section MUST be embedded, or Screen Recording
  # grants silently fail (Accessibility would still work, masking the bug).
  if ! otool -s __TEXT __info_plist "$BIN_PATH" 2>/dev/null | grep -q "(__TEXT,__info_plist) section"; then
    die "embedded __TEXT,__info_plist section missing at $BIN_PATH — Screen Recording grant would silently fail. Check the -sectcreate linker flag and $PKG_DIR/Info.plist."
  fi
  log "embedded Info.plist section: present"
}

# ---------------------------------------------------------------------------
# 5. Codesign with the stable identity + constant identifier.
#
#    --force            : replace any prior signature on rebuild
#    --options runtime  : Hardened Runtime (dev-safe + notarization-ready)
#    --identifier       : CONSTANT bundle id => stable TCC row across rebuilds
#    --timestamp        : required for Developer ID distribution/notarization
#    --timestamp=none   : fast offline local Apple Development/self-signed builds
# ---------------------------------------------------------------------------
sign() {
  resolve_timestamp_mode
  log ""
  log "==> codesign (identity='$SIGN_IDENTITY', identifier='$BUNDLE_ID', options=runtime, timestamp=$RESOLVED_TIMESTAMP_MODE)"

  codesign \
    --force \
    --options runtime \
    "$CODESIGN_TIMESTAMP_ARG" \
    --identifier "$BUNDLE_ID" \
    --sign "$SIGN_IDENTITY" \
    "$BIN_PATH" 1>&2

  # Rotation detection: persist what we signed with. If a later build sees a
  # different identity/identifier, TCC grants will have been dropped — warn.
  local stamp_value
  stamp_value="identity=${SIGN_IDENTITY}|identifier=${BUNDLE_ID}"
  if [ -f "$SIGN_STAMP" ]; then
    local prev
    prev="$(cat "$SIGN_STAMP" 2>/dev/null || true)"
    if [ -n "$prev" ] && [ "$prev" != "$stamp_value" ]; then
      log "warning: signing identity/identifier changed since the last build:"
      log "         was: $prev"
      log "         now: $stamp_value"
      log "         macOS will treat this as a NEW app — re-grant Accessibility + Screen Recording."
    fi
  fi
  printf '%s' "$stamp_value" > "$SIGN_STAMP"
}

# ---------------------------------------------------------------------------
# 6. Verify the signature + emit the Identifier/Authority lines.
#
#    This is the signing-stability acceptance probe: across two builds the
#    Identifier (must equal $BUNDLE_ID) and Authority lines must be identical.
# ---------------------------------------------------------------------------
verify() {
  log ""
  log "==> codesign --verify (strict)"
  if ! codesign --verify --strict --verbose=2 "$BIN_PATH" 1>&2; then
    die "codesign --verify failed for $BIN_PATH"
  fi

  log ""
  log "==> codesign -dv --verbose=4  (Identifier + Authority must be stable across rebuilds)"
  # Capture the display output and surface the lines the acceptance test checks.
  local dv
  dv="$(codesign -dv --verbose=4 "$BIN_PATH" 2>&1 || true)"
  printf '%s\n' "$dv" | grep -E 'Identifier=|Authority=|TeamIdentifier=|Sealed Resources|flags=' >&2 || true

  # Hard assertion: the Identifier MUST be the constant bundle id we asked for.
  local got_id
  got_id="$(printf '%s\n' "$dv" | grep -E '^Identifier=' | head -1 | sed -E 's/^Identifier=//')"
  if [ "$got_id" != "$BUNDLE_ID" ]; then
    die "signed Identifier='$got_id' does not match required constant '$BUNDLE_ID' (TCC row would not be stable)."
  fi
  if [ "$RESOLVED_TIMESTAMP_MODE" = "secure" ] && ! printf '%s\n' "$dv" | grep -q '^Timestamp='; then
    die "Developer ID signature is missing a secure Timestamp; notarization would reject $BIN_PATH."
  fi
  log ""
  log "verified: Identifier=$got_id (stable)"
}

# ---------------------------------------------------------------------------
# 7. Wrap the signed Mach-O in a minimal .app bundle and sign the WHOLE bundle.
#    Screen Recording only grants effective access to a real .app bundle (see the
#    APP_PATH comment). Contents/Info.plist (CFBundleIdentifier == $BUNDLE_ID)
#    makes the inner binary's TCC identity a proper app bundle.
# ---------------------------------------------------------------------------
copy_cursor_resources() {
  local res_bundle="$1"
  local destination_app="$2"
  [ -d "$res_bundle/LensSequence" ] || die "Cursor resource bundle not found at $res_bundle (SwiftPM must produce the declared LensSequence directory)."
  mkdir -p "$destination_app/Contents/Resources"
  cp -R "$res_bundle" "$destination_app/Contents/Resources/"
}

wrap_app() {
  [ -s "$APP_ICON_PATH" ] || die "App icon not found at $APP_ICON_PATH (needed for the Privacy lists)."
  log ""
  log "==> wrap .app bundle: $APP_PATH"
  rm -rf "$APP_PATH"
  mkdir -p "$APP_PATH/Contents/MacOS" "$APP_PATH/Contents/Resources"

  cp "$BIN_PATH" "$APP_PATH/Contents/MacOS/cc-haha-computer-use"

  [ -f "$PKG_DIR/Info.plist" ] || die "Info.plist not found at $PKG_DIR/Info.plist (needed for the .app bundle)."
  cp "$PKG_DIR/Info.plist" "$APP_PATH/Contents/Info.plist"
  cp "$APP_ICON_PATH" "$APP_PATH/Contents/Resources/icon.icns"

  # SwiftPM resource bundle (LensSequence overlay). Standard .app location is
  # Contents/Resources/ (Bundle.main.resourceURL). Do
  # NOT also put it in MacOS/ — a nested .bundle there breaks codesign with an
  # "In subcomponent" error. The optional sequence may contain only its README;
  # missing PNGs are supported, a missing declared build resource is not.
  local res_bundle="${RESOURCE_BUNDLE_PATH:-$BUILD_DIR/$BUILD_CONFIG/cu-helper_cc-haha-computer-use.bundle}"
  copy_cursor_resources "$res_bundle" "$APP_PATH"

  # Sign the WHOLE bundle with the SAME stable identity + hardened runtime.
  codesign \
    --force \
    --options runtime \
    "$CODESIGN_TIMESTAMP_ARG" \
    --identifier "$BUNDLE_ID" \
    --sign "$SIGN_IDENTITY" \
    "$APP_PATH" 1>&2

  if ! codesign --verify --strict --verbose=2 "$APP_PATH" 1>&2; then
    die "codesign --verify failed for $APP_PATH"
  fi
  local app_dv app_id
  app_dv="$(codesign -dv --verbose=4 "$APP_PATH" 2>&1 || true)"
  app_id="$(printf '%s\n' "$app_dv" | grep -E '^Identifier=' | head -1 | sed -E 's/^Identifier=//')"
  if [ "$app_id" != "$BUNDLE_ID" ]; then
    die ".app Identifier='$app_id' does not match required '$BUNDLE_ID'."
  fi
  if [ "$RESOLVED_TIMESTAMP_MODE" = "secure" ] && ! printf '%s\n' "$app_dv" | grep -q '^Timestamp='; then
    die "Developer ID signature is missing a secure Timestamp; notarization would reject $APP_PATH."
  fi
  log "verified: .app bundle Identifier=$app_id (stable)"
}

# Run the production loader from an independent .app location. Checking only a
# source-tree build can silently succeed through SwiftPM's absolute buildPath.
# The probe performs no input, GUI startup, permission checks, or user-state IO.
verify_relocated_cursor_resources() (
  local host_arch
  host_arch="$(uname -m)"
  if [ "$ARCH" != "$host_arch" ]; then
    log "skipped: cursor resource execution probe (target $ARCH, host $host_arch); package structure was verified before signing"
    return 0
  fi

  # The subshell isolates this variable. Bash 3 unwinds function-local variables
  # before an EXIT trap after die(), so it must remain available for cleanup.
  probe_root="$(mktemp -d "${TMPDIR:-/tmp}/cc-haha-cursor-probe.XXXXXX")"
  trap 'rm -rf "$probe_root"' EXIT
  local probe_app="$probe_root/cc-haha-computer-use.app"
  local report="$probe_root/resources.json"
  cp -R "$APP_PATH" "$probe_app"
  mkdir -p "$probe_root/home" "$probe_root/config" "$probe_root/tmp"
  if ! env -i \
    PATH=/usr/bin:/bin:/usr/sbin:/sbin \
    HOME="$probe_root/home" \
    CFFIXED_USER_HOME="$probe_root/home" \
    CLAUDE_CONFIG_DIR="$probe_root/config" \
    TMPDIR="$probe_root/tmp/" \
    "$probe_app/Contents/MacOS/cc-haha-computer-use" --probe-cursor-resources >"$report"; then
    die "Cursor resource probe failed for relocated helper $probe_app"
  fi

  local resource_directory
  resource_directory="$(/usr/bin/plutil -extract resourceDirectory raw -o - "$report" 2>/dev/null)" \
    || die "Cursor resource probe did not report a resourceDirectory"
  resource_directory="$(cd "$resource_directory" 2>/dev/null && pwd -P)" \
    || die "Cursor resource probe reported an unreadable resourceDirectory"
  local expected_directory="$probe_app/Contents/Resources/cu-helper_cc-haha-computer-use.bundle/LensSequence"
  [ -d "$expected_directory" ] || die "Cursor resource probe package is missing $expected_directory"
  expected_directory="$(cd "$expected_directory" && pwd -P)"
  local canonical_app
  canonical_app="$(cd "$probe_app" && pwd -P)"
  case "$expected_directory" in
    "$canonical_app"/*) ;;
    *) die "Cursor resource probe found resources outside relocated package: $expected_directory" ;;
  esac
  [ "$resource_directory" = "$expected_directory" ] \
    || die "Cursor resource probe loaded '$resource_directory' instead of relocated package '$expected_directory'"
  log "verified: relocated cursor resources ($resource_directory)"
)

# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------
main() {
  preflight
  resolve_identity
  build
  sign
  verify
  wrap_app
  verify_relocated_cursor_resources

  # The ONE machine-readable line on STDOUT — the .app BUNDLE path. The caller
  # (build-sidecars.ts) copies the whole .app; the runtime resolver
  # (cuHelperBridge.ts) targets <app>/Contents/MacOS/cc-haha-computer-use.
  printf 'built: %s\n' "$APP_PATH"
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi
