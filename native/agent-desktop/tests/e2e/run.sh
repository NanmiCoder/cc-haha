#!/usr/bin/env bash
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
if [ -z "${AGENT_DESKTOP_INTERACTION_LEASE_FD:-}" ]; then
    if [ "$(uname -s)" != "Darwin" ]; then
        echo "macOS is required for the native accessibility E2E suite" >&2
        exit 2
    fi
    if [ "${AGENT_DESKTOP_E2E_EXCLUSIVE:-}" != "1" ]; then
        echo "SKIP (blocked): native E2E requires an exclusive desktop" >&2
        exit 2
    fi
    CARGO_TARGET_DIR="$repo/target" cargo build --locked --release -p agent-desktop || exit 2
    CARGO_TARGET_DIR="$repo/target" cargo build --locked --release \
        -p agent-desktop-macos --bin agent-desktop-macos-helper || exit 2
    CARGO_TARGET_DIR="$repo/target" cargo build --locked --profile release-ffi \
        -p agent-desktop-ffi || exit 2
    export AGENT_DESKTOP_E2E_RELEASE_BIN="$repo/target/release/agent-desktop"
    export AGENT_DESKTOP_E2E_RELEASE_FFI="$repo/target/release-ffi/libagent_desktop_ffi.dylib"
    export AGENT_DESKTOP_E2E_RELEASE_FFI_HELPER="$repo/target/release/agent-desktop-macos-helper"
    exec python3 "$here/interaction_lock.py" run "$0" "$@"
fi
# shellcheck source=tests/e2e/lib.sh
source "$here/lib.sh"
trap cleanup EXIT

note "Global prerequisite gate"
if [ "$(uname -s)" != "Darwin" ]; then
    echo "macOS is required for the native accessibility E2E suite" >&2
    exit 2
fi
if [ ! -x "$release_bin" ]; then
    echo "release binary missing at $release_bin; run 'cargo build --release'" >&2
    exit 2
fi
if [ ! -f "$release_ffi" ] || [ ! -x "$release_ffi_helper" ]; then
    echo "release FFI bundle missing; build agent-desktop-ffi with release-ffi and the agent-desktop-macos-helper binary with release" >&2
    exit 2
fi
note "Strict headless non-interference gate"
AGENT_DESKTOP_E2E_RELEASE_BIN="$release_bin" bash "$here/safe-semantic.sh"
safe_semantic_status=$?
if [ "$safe_semantic_status" -ne 0 ]; then
    exit "$safe_semantic_status"
fi
if ! prepare_native_harness; then
    exit 2
fi
permission_json="$("$bin" permissions 2>/dev/null)"
ax_state="$(json_field "$permission_json" data.accessibility.state)"
if [ "$ax_state" != "granted" ]; then
    echo "accessibility permission not granted (state='${ax_state:-unknown}')." >&2
    echo "Grant trust to this terminal/runner in System Settings > Privacy & Security > Accessibility." >&2
    exit 2
fi
guard_exec 120 4194304 "$repo/tests/fixture-app/build.sh" "$suite_root/fixture" >/dev/null || {
    echo "fixture build failed; cannot run E2E" >&2
    exit 2
}
"$bin" --headed mouse-move --xy 20,20 >/dev/null 2>&1 || {
    echo "fixture cursor precondition could not be established" >&2
    exit 2
}

guard_exec 10 1048576 open "$fixture_app" || {
    echo "fixture could not be opened" >&2
    exit 2
}
fixture_owned=1

ready=""
tries=0
for _ in $(seq 1 20); do
    tries=$((tries + 1))
    "$bin" focus-window --app "$app" >/dev/null 2>&1 || true
    if find_target button primary-button >/dev/null; then
        ready=1
        break
    fi
    sleep 0.5
done
if [ -z "$ready" ]; then
    badmsg "fixture launched but primary-button was not exposed after $tries attempts"
    finish
    exit 1
fi
if ! record_fixture_process; then
    finish
    exit 1
fi
okmsg "fixture launched and primary-button exposed with exact snapshot namespace"

frame="$("$bin" list-displays 2>/dev/null | python3 -c '
import json, sys
d = json.load(sys.stdin)["data"]
best = max(d, key=lambda x: x["bounds"]["width"] * x["bounds"]["height"])
b = best["bounds"]
w = min(int(b["width"]) - 40, 1900)
h = min(int(b["height"]) - 34, 1080)
print(int(b["x"]) + 20, int(b["y"]) + 28, w, h)
')"
if [ -n "$frame" ]; then
    read -r fx fy fw fh <<EOF_FRAME
$frame
EOF_FRAME
    osascript -e "tell application \"System Events\" to tell process \"$app\"" \
        -e "set position of front window to {$fx, $fy}" \
        -e "set size of front window to {$fw, $fh}" \
        -e "end tell" >/dev/null 2>&1 || true
    sleep 0.5
    okmsg "fixture window normalized to {$fx,$fy} ${fw}x${fh} on the largest display"
else
    badmsg "fixture window normalization skipped: list-displays returned nothing"
fi

check_fixture_contention || { finish; exit 1; }
# shellcheck source=tests/e2e/scenarios/observation.sh
source "$here/scenarios/observation.sh"
check_fixture_contention || { finish; exit 1; }
# shellcheck source=tests/e2e/scenarios/interaction.sh
source "$here/scenarios/interaction.sh"
check_fixture_contention || { finish; exit 1; }
# shellcheck source=tests/e2e/scenarios/acceptance.sh
source "$here/scenarios/acceptance.sh"
check_fixture_contention || { finish; exit 1; }
# shellcheck source=tests/e2e/scenarios/reliability.sh
source "$here/scenarios/reliability.sh"
check_fixture_contention || { finish; exit 1; }
# shellcheck source=tests/e2e/scenarios/surfaces.sh
source "$here/scenarios/surfaces.sh"
check_fixture_contention || { finish; exit 1; }
# shellcheck source=tests/e2e/scenarios/error_contract.sh
source "$here/scenarios/error_contract.sh"
check_fixture_contention || { finish; exit 1; }
# shellcheck source=tests/e2e/scenarios/keyboard.sh
source "$here/scenarios/keyboard.sh"
check_fixture_contention || { finish; exit 1; }
# shellcheck source=tests/e2e/scenarios/trace_performance.sh
source "$here/scenarios/trace_performance.sh"
# shellcheck source=tests/e2e/scenarios/notifications.sh
source "$here/scenarios/notifications.sh"

note "Multi-agent cursor probe"
if [ "$fixture_owned" -eq 0 ] || "$bin" close-app "$app" --force >/dev/null 2>&1; then
    fixture_owned=0
    for mode in headless headed; do
        cursor_flags=()
        if [[ "$mode" == headed ]]; then cursor_flags=(--headed); fi
        if python3 "$repo/scripts/cursor-multi-agent-probe.py" \
            --bin "$raw_bin" \
            --fixture "$fixture_app/Contents/MacOS/AgentDeskFixture" \
            --out "$suite_root/multi-agent-cursor-$mode" "${cursor_flags[@]}"; then
            okmsg "$mode multi-agent cursors share session state and preserve renderer isolation"
        else
            badmsg "$mode multi-agent cursor probe failed"
        fi
    done
else
    badmsg "fixture could not be restarted for the multi-agent cursor probe"
fi

# shellcheck source=tests/e2e/scenarios/ref_churn.sh
source "$here/scenarios/ref_churn.sh"

finish
