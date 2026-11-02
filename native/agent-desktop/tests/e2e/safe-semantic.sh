#!/usr/bin/env bash
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -z "${AGENT_DESKTOP_INTERACTION_LEASE_FD:-}" ]; then
    exec python3 "$here/interaction_lock.py" run "$0" "$@"
fi
# shellcheck source=tests/e2e/harness.sh
source "$here/harness.sh"

safety_guard="$here/safe_semantic_guard.py"
app="AgentDeskFixture"
source_binary="${AGENT_DESKTOP_E2E_RELEASE_BIN:-}"
source_sha=""
bin=""
bin_sha=""
fixture_app=""
fixture_executable=""
fixture_executable_sha=""
fixture_pid=""
fixture_parent=""
fixture_process_token=""
fixture_identity=""
fixture_window_id=""
fixture_started=0
pass_count=0

fail() {
    printf 'FAIL: %s\n' "$1" >&2
    exit 1
}

blocked() {
    printf 'SKIP (blocked): %s\n' "$1" >&2
    exit 2
}

pass() {
    pass_count=$((pass_count + 1))
    printf 'PASS: %s\n' "$1"
}

json_field() {
    printf '%s' "$1" | python3 "$json_tool" get "$2" 2>/dev/null
}

target_ref() {
    printf '%s' "${1%%$'\t'*}"
}

target_snapshot() {
    printf '%s' "${1#*$'\t'}"
}

verify_source_binary() {
    local current
    [ -x "$source_binary" ] || return 1
    current="$(shasum -a 256 "$source_binary" | awk '{print $1}')" || return 1
    [ "$current" = "$source_sha" ]
}

agent_exec() {
    local armed="$1"
    shift
    python3 "$safety_guard" command "$app" "$fixture_window_id" "$armed" -- "$@" || return 97
    guard_agent_wrapper_exec 8 2097152 "$bin" "$@"
}

capture_frontmost() {
    local output guard_args=(frontmost)
    if [ "$#" -eq 1 ]; then
        guard_args=(non-fixture-frontmost "$1")
    fi
    output="$(agent_exec 0 list-windows 2>/dev/null)" || return 1
    printf '%s' "$output" | python3 "$safety_guard" "${guard_args[@]}" 2>/dev/null
}

wait_frontmost() {
    for _ in 1 2 3; do
        capture_frontmost "$@" >/dev/null && return 0
        sleep 0.1
    done
    return 1
}

fixture_is_not_frontmost() {
    wait_frontmost "$fixture_pid"
}

capture_fixture_identity() {
    local windows_output windows_file
    windows_output="$(agent_exec 0 list-windows --app "$app" 2>/dev/null)" || return 1
    windows_file="$suite_root/fixture-windows.json"
    printf '%s' "$windows_output" > "$windows_file" || return 1
    chmod 600 "$windows_file" || return 1
    python3 "$safety_guard" fixture-window "$app" "$fixture_pid" "$windows_file" 2>/dev/null
}

process_token() {
    /bin/ps -p "$1" -o pid= -o ppid= -o lstart= -o command= 2>/dev/null
}

process_parent() {
    /bin/ps -p "$1" -o ppid= 2>/dev/null | tr -d '[:space:]'
}

fixture_pids_are_exact() {
    local current
    current="$(pgrep -x "$app" 2>/dev/null || true)"
    [ "$current" = "$fixture_pid" ]
}

safety_checkpoint() {
    local current_token current_parent current_fixture windows
    verify_immutable_binary "$bin" "$bin_sha" || {
        fail_checkpoint "frozen binary changed"; return 1;
    }
    verify_source_binary || { fail_checkpoint "source binary changed"; return 1; }
    verify_immutable_binary "$fixture_executable" "$fixture_executable_sha" || \
        { fail_checkpoint "fixture executable changed"; return 1; }
    fixture_pids_are_exact || { fail_checkpoint "fixture PID set changed"; return 1; }
    kill -0 "$fixture_pid" 2>/dev/null || { fail_checkpoint "fixture process exited"; return 1; }
    current_token="$(process_token "$fixture_pid")" || {
        fail_checkpoint "fixture token unreadable"; return 1;
    }
    current_parent="$(process_parent "$fixture_pid")" || {
        fail_checkpoint "fixture parent unreadable"; return 1;
    }
    [ -n "$current_token" ] && [ "$current_token" = "$fixture_process_token" ] || \
        { fail_checkpoint "fixture process identity changed"; return 1; }
    [ "$current_parent" = "$fixture_parent" ] || {
        fail_checkpoint "fixture parent changed"; return 1;
    }
    current_fixture="$(capture_fixture_identity)" || {
        fail_checkpoint "fixture window identity changed"; return 1;
    }
    [ "$current_fixture" = "$fixture_identity" ] || {
        fail_checkpoint "fixture window details changed"; return 1;
    }
    fixture_is_not_frontmost || {
        windows="$(agent_exec 0 list-windows 2>/dev/null)"
        printf 'safety checkpoint failed: fixture became frontmost or focus was ambiguous output=%s\n' \
            "$windows" >&2
        return 1
    }
}

fail_checkpoint() {
    printf 'safety checkpoint failed: %s\n' "$1" >&2
    return 1
}

find_target() {
    local variable="$1" role="$2" name="$3" output target
    if ! output="$(agent_exec 0 find --app "$app" --window-id "$fixture_window_id" \
        --role "$role" --name "$name" --exact --limit 2 2>/dev/null)"; then
        printf 'fixture-only target command diagnostic: %s\n' "$output" >&2
        return 1
    fi
    if ! target="$(printf '%s' "$output" | python3 "$safety_guard" target "$role" "$name" 2>/dev/null)"; then
        printf 'fixture-only target diagnostic: %s\n' "$output" >&2
        return 1
    fi
    printf -v "$variable" '%s' "$target"
}

read_status() {
    local variable="$1" name="$2" output status_value
    output="$(agent_exec 0 find --app "$app" --window-id "$fixture_window_id" \
        --role statictext --native-id "$name" --exact --limit 2)" || {
        printf 'fixture status command failed: %s output=%s\n' "$name" "$output" >&2
        return 1
    }
    status_value="$(printf '%s' "$output" | python3 "$safety_guard" value "$name")" || {
        printf 'fixture status validation failed: %s output=%s\n' "$name" "$output" >&2
        return 1
    }
    printf -v "$variable" '%s' "$status_value"
}

run_mutation() {
    local expectation="$1" action="$2" output
    shift 2
    safety_checkpoint || fail "ownership or frontmost identity changed before mutation"
    if ! output="$(agent_exec 1 "$action" "$@")"; then
        printf '%s\n' "$output" >&2
        fail "safe semantic action failed"
    fi
    printf '%s' "$output" | python3 "$safety_guard" semantic-action "$action" "$expectation" \
        >/dev/null 2>&1 || fail "action result did not prove the expected semantic mechanism"
    sleep 0.2
    safety_checkpoint || fail "ownership or frontmost identity changed after mutation"
}

run_simple_action() {
    local expectation="$1" action="$2" target="$3"
    run_mutation "$expectation" "$action" "$(target_ref "$target")" \
        --timeout-ms 1500
}

run_set_value() {
    local target="$1" value="$2"
    run_mutation changed set-value "$(target_ref "$target")" "$value" \
        --timeout-ms 1500
}

run_type() {
    local target="$1" value="$2"
    run_mutation changed type "$(target_ref "$target")" "$value" \
        --timeout-ms 1500
}

await_status() {
    local variable="$1" name="$2" mode="$3" expected="$4" value="" attempts=0 observed=0
    while [ "$attempts" -lt 20 ]; do
        if read_status value "$name"; then
            observed=1
            if [ "$mode" = "equal" ] && [ "$value" = "$expected" ]; then
                printf -v "$variable" '%s' "$value"
                return 0
            fi
            if [ "$mode" = "different" ] && [ "$value" != "$expected" ]; then
                printf -v "$variable" '%s' "$value"
                return 0
            fi
        fi
        attempts=$((attempts + 1))
        sleep 0.1
    done
    if [ "$observed" -eq 1 ]; then
        printf 'fixture status wait exhausted: %s expected=%q actual=%q\n' \
            "$name" "$expected" "$value" >&2
    fi
    return 1
}

close_owned_fixture() {
    local current_token state attempts=0
    [ "$fixture_started" -eq 1 ] || return 0
    current_token="$(process_token "$fixture_pid")" || return 1
    [ -n "$current_token" ] && [ "$current_token" = "$fixture_process_token" ] || return 1
    [ "$(process_parent "$fixture_pid")" = "$fixture_parent" ] || return 1
    kill -TERM "$fixture_pid" 2>/dev/null || return 1
    while [ "$attempts" -lt 30 ]; do
        state="$(/bin/ps -p "$fixture_pid" -o state= 2>/dev/null | tr -d '[:space:]')"
        case "$state" in
            ''|Z*) break ;;
        esac
        attempts=$((attempts + 1))
        sleep 0.1
    done
    state="$(/bin/ps -p "$fixture_pid" -o state= 2>/dev/null | tr -d '[:space:]')"
    if [ -n "$state" ] && [ "${state#Z}" = "$state" ]; then
        [ "$(process_token "$fixture_pid")" = "$fixture_process_token" ] || return 1
        kill -KILL "$fixture_pid" 2>/dev/null || return 1
    fi
    wait "$fixture_pid" 2>/dev/null || true
    fixture_started=0
    [ -z "$(pgrep -x "$app" 2>/dev/null || true)" ]
}

cleanup() {
    if [ "$fixture_started" -eq 1 ]; then
        close_owned_fixture || printf 'cleanup refused an ambiguous fixture process\n' >&2
    fi
    cleanup_isolated_environment
}

trap cleanup EXIT

[ "$(uname -s)" = "Darwin" ] || blocked "safe semantic native E2E requires macOS"
acquire_exclusive_lock || blocked "safe semantic E2E could not verify its exclusive interaction lease"
[ -n "$source_binary" ] || blocked "AGENT_DESKTOP_E2E_RELEASE_BIN must name the reviewed binary"
case "$source_binary" in
    /*) ;;
    *) blocked "AGENT_DESKTOP_E2E_RELEASE_BIN must be an absolute path" ;;
esac
[ -x "$source_binary" ] || blocked "reviewed release binary is missing or not executable"
[ -f "$safety_guard" ] || blocked "safe semantic policy guard is missing"

source_sha="$(shasum -a 256 "$source_binary" | awk '{print $1}')" || blocked "cannot hash reviewed binary"
setup_isolated_environment safe-semantic || blocked "cannot create isolated HOME and TMPDIR"
copy_immutable_binary "$source_binary" agent-desktop || blocked "cannot freeze reviewed binary"
bin="$prepared_binary"
bin_sha="$prepared_binary_sha"
[ "$bin_sha" = "$source_sha" ] || blocked "reviewed binary changed before it was frozen"

version_json="$(agent_exec 0 version 2>/dev/null)" || blocked "reviewed binary version command failed"
expected_version="$(awk -F'"' '/^version[[:space:]]*=/{print $2; exit}' "$repo/Cargo.toml")"
actual_version="$(json_field "$version_json" data.version)"
[ -n "$expected_version" ] && [ "$actual_version" = "$expected_version" ] || \
    blocked "reviewed binary version does not match the checkout"

permission_json="$(agent_exec 0 permissions 2>/dev/null)" || blocked "accessibility permission probe failed"
ax_state="$(json_field "$permission_json" data.accessibility.state)"
[ "$ax_state" = "granted" ] || blocked "accessibility permission is not granted"

AGENT_DESKTOP_FIXTURE_BACKGROUND_BUNDLE=1 \
    guard_exec 120 4194304 "$repo/tests/fixture-app/build.sh" "$suite_root/fixture" >/dev/null || \
    blocked "fixture build failed"
fixture_app="$suite_root/fixture/AgentDeskFixture.app"
fixture_executable="$fixture_app/Contents/MacOS/$app"
[ -x "$fixture_executable" ] || blocked "fixture executable is missing"
fixture_bundle_id="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' \
    "$fixture_app/Contents/Info.plist" 2>/dev/null)" || blocked "fixture bundle identity is unreadable"
[ "$fixture_bundle_id" = "com.agentdesktop.fixture" ] || blocked "fixture bundle identity is invalid"
fixture_agent_mode="$(/usr/libexec/PlistBuddy -c 'Print :LSUIElement' \
    "$fixture_app/Contents/Info.plist" 2>/dev/null)" || blocked "fixture agent mode is unreadable"
[ "$fixture_agent_mode" = "true" ] || blocked "fixture is not an LSUIElement agent"
fixture_executable_sha="$(shasum -a 256 "$fixture_executable" | awk '{print $1}')" || \
    blocked "fixture executable cannot be hashed"
chmod 500 "$fixture_executable" || blocked "fixture executable cannot be frozen"
[ -z "$(pgrep -x "$app" 2>/dev/null || true)" ] || \
    blocked "an unowned fixture process is already running"

wait_frontmost || blocked "frontmost identity is missing or ambiguous"

AGENT_DESKTOP_FIXTURE_NO_ACTIVATE=1 "$fixture_executable" \
    >"$suite_root/fixture.stdout" 2>"$suite_root/fixture.stderr" &
fixture_pid=$!
fixture_started=1
fixture_parent="$$"

attempts=0
while [ "$attempts" -lt 20 ]; do
    fixture_process_token="$(process_token "$fixture_pid")"
    if [ -n "$fixture_process_token" ] && [ "$(process_parent "$fixture_pid")" = "$fixture_parent" ]; then
        break
    fi
    attempts=$((attempts + 1))
    sleep 0.1
done
[ -n "$fixture_process_token" ] || fail "spawned fixture process identity was not observable"

attempts=0
while [ "$attempts" -lt 30 ]; do
    fixture_is_not_frontmost || fail "fixture launch made the owned process frontmost"
    if fixture_identity="$(capture_fixture_identity)"; then
        break
    fi
    kill -0 "$fixture_pid" 2>/dev/null || fail "spawned fixture exited before exposing its surface"
    attempts=$((attempts + 1))
    sleep 0.2
done
[ -n "$fixture_identity" ] || fail "fixture did not expose one unambiguous owned window"
fixture_window_id="$(json_field "$fixture_identity" window_id)"
[ -n "$fixture_window_id" ] || fail "fixture window has no stable identity"
safety_checkpoint || fail "initial ownership and frontmost checkpoint failed"
pass "fixture launched in background with exact PID, generation, and window ownership"

await_status click_before click-status equal idle || fail "fresh fixture click status is unavailable or not idle"
find_target primary button primary-button || fail "primary button is not uniquely addressable"
run_simple_action changed click "$primary"
await_status click_after click-status equal click-1 || fail "click did not produce exactly one fixture effect"
pass "AXPress click produced exactly one effect"

read_status text_before text-echo || fail "text status is unavailable"
[ -z "$text_before" ] || fail "fresh text fixture state is not clean"
text_value="safe-semantic-$fixture_pid"
find_target text_field textfield text-input || fail "text field is not uniquely addressable"
run_type "$text_field" "$text_value"
await_status text_after text-echo equal "$text_value" || fail "semantic type did not reach fixture state"
pass "AXSelectedText type produced the fixture-owned binding change without focus"
text_value="safe-semantic-set-$fixture_pid"
find_target text_field textfield text-input || fail "text field disappeared after semantic type"
run_set_value "$text_field" "$text_value"
await_status text_after text-echo equal "$text_value" || fail "semantic set-value did not reach fixture state"
pass "AX set-value produced the fixture-owned binding change"
source "$here/scenarios/silent-text.sh"

read_status toggle_before toggle-status || fail "toggle status is unavailable"
[ "$toggle_before" = "off" ] || fail "fresh toggle state is not clean"
find_target toggle checkbox toggle-box || fail "checkbox is not uniquely addressable"
run_simple_action changed check "$toggle"
await_status toggle_state toggle-status equal on || fail "check did not set the fixture checkbox"
find_target toggle checkbox toggle-box || fail "checkbox disappeared after check"
run_simple_action noop check "$toggle"
find_target toggle checkbox toggle-box || fail "checkbox disappeared before uncheck"
run_simple_action changed uncheck "$toggle"
await_status toggle_state toggle-status equal off || fail "uncheck did not clear the fixture checkbox"
find_target toggle checkbox toggle-box || fail "checkbox disappeared after uncheck"
run_simple_action noop uncheck "$toggle"
find_target toggle checkbox toggle-box || fail "checkbox disappeared before toggle"
run_simple_action changed toggle "$toggle"
await_status toggle_state toggle-status equal on || fail "toggle did not turn fixture state on"
find_target toggle checkbox toggle-box || fail "checkbox disappeared between toggles"
run_simple_action changed toggle "$toggle"
await_status toggle_state toggle-status equal off || fail "second toggle did not restore fixture state"
pass "check, uncheck, idempotence, and toggle are semantic"

safety_checkpoint || fail "final mutation checkpoint failed"
close_owned_fixture || fail "could not close the exact spawned fixture PID"
wait_frontmost || fail "final frontmost identity is missing or ambiguous"
verify_immutable_binary "$bin" "$bin_sha" || fail "immutable binary copy changed"
verify_source_binary || fail "reviewed binary changed during the suite"
pass "owned fixture never became frontmost while unrelated user focus remained unconstrained"
printf 'SAFE SEMANTIC E2E PASSED: %d assertions; sha256=%s\n' "$pass_count" "$bin_sha"
