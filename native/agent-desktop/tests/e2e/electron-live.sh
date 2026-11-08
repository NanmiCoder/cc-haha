#!/usr/bin/env bash
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -z "${AGENT_DESKTOP_INTERACTION_LEASE_FD:-}" ]; then
    exec python3 "$here/interaction_lock.py" run "$0" "$@"
fi
# shellcheck source=tests/e2e/harness.sh
source "$here/harness.sh"

app=""
out=""
baseline_source=""
current_binary=""
current_sha=""
baseline_binary=""
baseline_sha=""
contaminated=0
report_started=0

cleanup() {
    if [ -n "$current_binary" ] && ! verify_immutable_binary "$current_binary" "$current_sha"; then
        contaminated=1
    fi
    if [ -n "$baseline_binary" ] && ! verify_immutable_binary "$baseline_binary" "$baseline_sha"; then
        contaminated=1
    fi
    if [ "$contaminated" -ne 0 ] && [ "$report_started" -eq 1 ] && [ -n "$out" ]; then
        if remove_artifact "$out"; then
            echo "measurement was contaminated; report removed" >&2
        else
            echo "measurement was contaminated; retained report must not be used: $out" >&2
        fi
    fi
    cleanup_isolated_environment
    release_exclusive_lock
}
trap cleanup EXIT

while [ "$#" -gt 0 ]; do
    case "$1" in
        --app) app="${2:-}"; shift 2 ;;
        --out) out="${2:-}"; shift 2 ;;
        --baseline-binary) baseline_source="${2:-}"; shift 2 ;;
        *) echo "usage: $0 --app Slack [--baseline-binary PATH] [--out PATH]" >&2; exit 2 ;;
    esac
done

if [ "$(uname -s)" != "Darwin" ]; then
    echo "electron-live requires macOS" >&2
    exit 2
fi
if [ -z "$app" ]; then
    echo "--app is required (for example: --app Slack)" >&2
    exit 2
fi
if [ ! -x "$release_bin" ]; then
    echo "release binary missing at $release_bin" >&2
    exit 2
fi
require_exclusive_acknowledgement || exit 2
acquire_exclusive_lock || exit 2
setup_isolated_environment electron || exit 2
copy_immutable_binary "$release_bin" current-agent-desktop || exit 2
current_binary="$prepared_binary"
current_sha="$prepared_binary_sha"
export AGENT_DESKTOP_E2E_BINARY="$current_binary"
bin="$command_guard"

if [ -n "$baseline_source" ]; then
    copy_immutable_binary "$baseline_source" baseline-agent-desktop || exit 2
    baseline_binary="$prepared_binary"
    baseline_sha="$prepared_binary_sha"
fi

expected_version="$(awk -F'"' '/^version[[:space:]]*=/{print $2; exit}' "$repo/Cargo.toml")"
version_json="$("$bin" version 2>/dev/null)" || exit 2
current_version="$(printf '%s' "$version_json" | python3 "$json_tool" get data.version 2>/dev/null)"
if [ -z "$expected_version" ] || [ "$current_version" != "$expected_version" ]; then
    echo "current binary version mismatch: Cargo='$expected_version' binary='$current_version'" >&2
    exit 2
fi

installed_path=""
for applications_dir in /Applications "$host_home/Applications"; do
    if [ -d "$applications_dir/$app.app" ]; then
        installed_path="$applications_dir/$app.app"
        break
    fi
done
if [ -z "$installed_path" ] && ! guard_exec 10 1048576 open -Ra "$app" >/dev/null 2>&1; then
    echo "installed application '$app' was not found by Launch Services" >&2
    exit 2
fi

permission_json="$("$bin" permissions 2>/dev/null)"
permission_state="$(printf '%s' "$permission_json" | python3 "$json_tool" get data.accessibility.state 2>/dev/null)"
if [ "$permission_state" != "granted" ]; then
    echo "Accessibility permission must be granted; current state is '${permission_state:-unknown}'" >&2
    exit 2
fi

app_json="$("$bin" list-apps --app "$app" 2>/dev/null)"
app_running="$(printf '%s' "$app_json" | python3 -c '
import json, sys
data = json.load(sys.stdin)
print(1 if any(item.get("name", "").casefold() == sys.argv[1].casefold()
               for item in data.get("data", {}).get("apps", [])) else 0)
' "$app" 2>/dev/null)"
if [ "$app_running" != "1" ]; then
    echo "'$app' is installed but not running; start it without changing its UI state, then retry" >&2
    exit 2
fi

window_json="$("$bin" list-windows --app "$app" 2>/dev/null)"
window_count="$(printf '%s' "$window_json" | python3 -c \
    'import json,sys; print(len(json.load(sys.stdin).get("data",[])))' 2>/dev/null)"
if [ "${window_count:-0}" -lt 1 ]; then
    echo "'$app' has no accessibility window to measure" >&2
    exit 2
fi

if [ -z "$out" ]; then
    slug="$(printf '%s' "$app" | tr '[:upper:] ' '[:lower:]-' | tr -cd 'a-z0-9._-')"
    out="/tmp/agent-desktop-electron-${slug}-$(date -u +%Y%m%dT%H%M%SZ).json"
fi
if [ -e "$out" ] || [ -L "$out" ]; then
    echo "refusing to overwrite an existing report: $out" >&2
    exit 2
fi

baseline_args=()
if [ -n "$baseline_binary" ]; then
    baseline_args=(--baseline-binary "$baseline_binary")
fi
report_started=1
guard_agent_wrapper_exec 1800 4194304 python3 "$repo/tests/e2e/electron_metrics.py" \
    --binary "$current_binary" "${baseline_args[@]}" --app "$app" --out "$out" \
    --work-root "$suite_root" --warmups 5 --samples 31 >/dev/null || exit 1

verify_immutable_binary "$current_binary" "$current_sha" || { contaminated=1; exit 1; }
if [ -n "$baseline_binary" ]; then
    verify_immutable_binary "$baseline_binary" "$baseline_sha" || { contaminated=1; exit 1; }
fi
printf '%s\n' "$out"
