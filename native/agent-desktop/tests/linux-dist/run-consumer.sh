#!/usr/bin/env bash
# Drive the packaged FFI library against a real application.
#
# Usage: run-consumer.sh <extracted-ffi-archive-dir>
#
# The directory must hold lib/libagent_desktop_ffi.so and
# include/agent_desktop.h, the layout the release archive ships. Every numbered
# leg is one assertion and names the code the library returned. The run fails
# closed when no target registers; nothing is skipped.
set -euo pipefail

ARCHIVE=${1:?usage: run-consumer.sh <extracted-ffi-archive-dir>}
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
LIB_DIR="$ARCHIVE/lib"
INCLUDE_DIR="$ARCHIVE/include"
LIBRARY="$LIB_DIR/libagent_desktop_ffi.so"
HEADER="$INCLUDE_DIR/agent_desktop.h"
APP=${AD_APP:-gnome-calculator}
ATSPI_APP=${AD_ATSPI_APP:-calculator}

for file in "$LIBRARY" "$HEADER"; do
  [ -r "$file" ] || { echo "run-consumer: missing $file" >&2; exit 2; }
done
command -v cc >/dev/null 2>&1 || { echo "run-consumer: cc is required" >&2; exit 2; }
command -v python3 >/dev/null 2>&1 || { echo "run-consumer: python3 is required" >&2; exit 2; }

WORK=$(mktemp -d "${AGENT_DESKTOP_PRIVATE_SESSION:-${TMPDIR:-/tmp}}/ad-consumer.XXXXXX")
export AGENT_DESKTOP_HOME="$WORK/state"
mkdir -m 700 "$AGENT_DESKTOP_HOME"
mkdir -p "$WORK/nopath" "$WORK/bus"
APP_PID=

# shellcheck disable=SC2329,SC2317
cleanup() {
  if [ -n "$APP_PID" ]; then
    kill "$APP_PID" 2>/dev/null || true
  fi
  rm -rf -- "$WORK"
}
trap cleanup EXIT

echo "run-consumer: compiling against $LIBRARY"
cc -std=gnu11 -Wall -Wextra -Werror -O2 -I"$INCLUDE_DIR" "$SCRIPT_DIR/consumer.c" \
  -L"$LIB_DIR" -Wl,-rpath,"$LIB_DIR" -l:libagent_desktop_ffi.so -lpthread \
  -o "$WORK/consumer"
CONSUMER="$WORK/consumer"

stop_app() {
  local pid=${APP_PID:-}
  [ -n "$pid" ] || return 0
  kill "$pid" 2>/dev/null || true
  for _ in $(seq 1 100); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.05
  done
  kill -9 "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  APP_PID=
}

launch_app() {
  "$APP" >/dev/null 2>&1 &
  APP_PID=$!
}

read_display() {
  python3 "$SCRIPT_DIR/atspi_read.py" --app "$ATSPI_APP" --timeout "${1:-20}"
}

wait_registered() {
  read_display 30 >/dev/null
}

snapshot_target() {
  local label=$1
  for _ in $(seq 1 100); do
    "$CONSUMER" snapshot "$APP" > "$SNAP" 2>"$WORK/snapshot.err" && return 0
    sleep 0.1
  done
  echo "run-consumer: FAIL code=$(sed -n 's/.*code=\([A-Z_]*\).*/\1/p' "$WORK/snapshot.err" | tail -1) target=$label ($APP did not snapshot)" >&2
  return 1
}

. "$SCRIPT_DIR/observations.sh"

read_clipboard() {
  python3 - <<'PY'
import sys
import time

import gi

gi.require_version("Gtk", "3.0")
gi.require_version("Gdk", "3.0")
from gi.repository import Gdk, Gtk

Gtk.init([])
clipboard = Gtk.Clipboard.get(Gdk.SELECTION_CLIPBOARD)
deadline = time.monotonic() + 5
while time.monotonic() < deadline:
    text = clipboard.wait_for_text()
    if text is not None:
        print(text)
        sys.exit(0)
    while Gtk.events_pending():
        Gtk.main_iteration()
    time.sleep(0.1)
sys.exit(3)
PY
}


echo "run-consumer: leg abi"
"$CONSUMER" abi

echo "run-consumer: leg handshake"
"$CONSUMER" handshake

echo "run-consumer: leg windows-exact"
"$CONSUMER" windows-exact "$APP"

wait_target_absent() {
  python3 "$SCRIPT_DIR/atspi_read.py" --app "$ATSPI_APP" --absent --timeout 30 || {
    echo "run-consumer: FAIL code=STALE_TARGET the previous $APP never left the registry" >&2
    exit 1
  }
}

wait_target_absent
launch_app
SNAP="$WORK/snapshot.json"
if ! wait_registered; then
  echo "run-consumer: FAIL code=APP_NOT_FOUND target=snapshot ($APP never registered)" >&2
  exit 1
fi
snapshot_target snapshot
python3 - "$SNAP" <<'PY'
import json
import sys

document = json.load(open(sys.argv[1], encoding="utf-8"))
data = document["data"]
assert document["ok"] is True, "snapshot is not ok"
assert data["complete"] is True, "snapshot is incomplete"
assert data["ref_count"] > 0, "snapshot allocated no refs"
PY
echo "run-consumer: leg snapshot ok"

echo "run-consumer: leg real ctypes main/worker"
AD_EXPECT_REAL=1 AD_APP="$APP" AD_DYLIB_PATH="$LIBRARY" AD_HEADER_PATH="$HEADER" \
  python3 "$SCRIPT_DIR/../ffi-python/smoke.py"

echo "run-consumer: leg click"
click_display_transition "$SNAP" "$WORK/click.json" "$CONSUMER" click

stop_app
wait_target_absent
launch_app
if ! wait_registered; then
  echo "run-consumer: FAIL code=APP_NOT_FOUND target=relaunch ($APP never registered)" >&2
  exit 1
fi
snapshot_target relaunch

echo "run-consumer: leg lifetime"
"$CONSUMER" lifetime "$APP"

echo "run-consumer: leg serialise"
"$CONSUMER" serialise "$APP"

echo "run-consumer: leg lost-bus"
"$CONSUMER" bus "$APP" "$WORK/bus" &
BUS_PID=$!
for _ in $(seq 1 300); do
  [ -f "$WORK/bus/kill-request" ] && break
  kill -0 "$BUS_PID" 2>/dev/null || break
  sleep 0.1
done
if [ ! -f "$WORK/bus/kill-request" ]; then
  echo "run-consumer: FAIL code=BUS_KILL consumer never requested the kill" >&2
  wait "$BUS_PID" 2>/dev/null || true
  exit 1
fi
if ! python3 "$SCRIPT_DIR/private_bus.py" "$AGENT_DESKTOP_PRIVATE_SESSION"; then
  echo "run-consumer: FAIL code=BUS_NOT_FOUND private accessibility bus did not stop" >&2
  wait "$BUS_PID" 2>/dev/null || true
  exit 1
fi
touch "$WORK/bus/killed"

for _ in $(seq 1 300); do
  [ -f "$WORK/bus/relaunch-request" ] && break
  kill -0 "$BUS_PID" 2>/dev/null || break
  sleep 0.1
done
if [ ! -f "$WORK/bus/relaunch-request" ]; then
  echo "run-consumer: FAIL code=INTERNAL consumer did not observe the lost bus" >&2
  wait "$BUS_PID" 2>/dev/null || true
  exit 1
fi
stop_app
launch_app
if ! wait_registered; then
  echo "run-consumer: FAIL code=APP_NOT_FOUND target=bus-relaunch ($APP never registered)" >&2
  wait "$BUS_PID" 2>/dev/null || true
  exit 1
fi
touch "$WORK/bus/relaunched"
if ! wait "$BUS_PID"; then
  echo "run-consumer: FAIL code=BUS_RECOVERY the adapter did not recover" >&2
  exit 1
fi
echo "run-consumer: leg lost-bus ok"

echo "run-consumer: leg clipboard"
CLIP_TEXT="agent-desktop-ffi-clipboard-$RANDOM"
if ! CLIP_OUT=$(env PATH="$WORK/nopath" "$CONSUMER" clipboard-set "$CLIP_TEXT" 2>&1); then
  echo "run-consumer: FAIL code=$(printf '%s' "$CLIP_OUT" | sed -n 's/.*code=\([A-Z_]*\).*/\1/p' | tail -1) target=clipboard-set" >&2
  exit 1
fi
READBACK=""
for _ in $(seq 1 100); do
  READBACK=$(read_clipboard) || READBACK=""
  [ "$READBACK" = "$CLIP_TEXT" ] && break
  sleep 0.05
done
if [ "$READBACK" != "$CLIP_TEXT" ]; then
  echo "run-consumer: FAIL code=CLIPBOARD_SET read=$READBACK expected=$CLIP_TEXT" >&2
  exit 1
fi
if ! CLIP_OUT=$(env PATH="$WORK/nopath" "$CONSUMER" clipboard-clear 2>&1); then
  echo "run-consumer: FAIL code=$(printf '%s' "$CLIP_OUT" | sed -n 's/.*code=\([A-Z_]*\).*/\1/p' | tail -1) target=clipboard-clear" >&2
  exit 1
fi
observe_clipboard_clear
echo "run-consumer: leg clipboard ok (text=$CLIP_TEXT, cleared)"
echo "run-consumer: all legs passed"
