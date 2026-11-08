#!/usr/bin/env bash
set -euo pipefail

ROOT=$(git rev-parse --show-toplevel)
cd "$ROOT"

TARGET_ROOT=${CARGO_TARGET_DIR:-target}
TARGET=${1:-$(rustc -vV | sed -n 's/^host: //p')}
PROBE_DIR="$TARGET_ROOT/$TARGET/panic-probe"
mkdir -p "$PROBE_DIR"

case "$TARGET" in
  *-apple-darwin) LIB_NAME=libagent_desktop_ffi.dylib; PROBE_NAME=probe ;;
  *-unknown-linux-gnu) LIB_NAME=libagent_desktop_ffi.so; PROBE_NAME=probe ;;
  *-pc-windows-msvc) LIB_NAME=agent_desktop_ffi.dll; PROBE_NAME=probe.exe ;;
  *) echo "FAIL: unsupported probe target: $TARGET" >&2; exit 1 ;;
esac

cargo build --locked --profile release-ffi -p agent-desktop-ffi --features panic-injection --target "$TARGET"
rustc --edition=2024 --target "$TARGET" crates/ffi/tests/cdylib_panic_probe.rs -o "$PROBE_DIR/$PROBE_NAME"
"$PROBE_DIR/$PROBE_NAME" "$TARGET_ROOT/$TARGET/release-ffi/$LIB_NAME"
