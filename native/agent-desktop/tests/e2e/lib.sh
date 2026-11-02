e2e_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=tests/e2e/harness.sh
source "$e2e_dir/harness.sh"

bin=""
raw_bin=""
raw_bin_sha=""
fixture_app=""
app="AgentDeskFixture"
fixture_pid=""
fixture_owned=0
fixture_started=0
contaminated=0
ffi_dylib=""
ffi_dylib_sha=""
ffi_helper=""
ffi_helper_sha=""

pass=0
fail=0
skip=0
declare -a failures=()
declare -a skips=()
declare -a cleanup_files=()
MODE_FLAG=""

prepare_native_harness() {
    require_exclusive_acknowledgement || return 1
    acquire_exclusive_lock || return 1
    setup_isolated_environment fixture || return 1
    copy_immutable_binary "$release_bin" agent-desktop || return 1
    raw_bin="$prepared_binary"
    raw_bin_sha="$prepared_binary_sha"
    export AGENT_DESKTOP_E2E_BINARY="$raw_bin"
    bin="$command_guard"
    copy_native_ffi_bundle || return 1
    ffi_dylib="$AGENT_DESKTOP_E2E_FFI_DYLIB"
    ffi_dylib_sha="$AGENT_DESKTOP_E2E_FFI_DYLIB_SHA"
    ffi_helper="$(dirname "$ffi_dylib")/agent-desktop-macos-helper"
    ffi_helper_sha="$AGENT_DESKTOP_E2E_FFI_HELPER_SHA"
    fixture_app="$suite_root/fixture/AgentDeskFixture.app"

    local expected_version version_json actual_version clap_version existing
    expected_version="$(awk -F'"' '/^version[[:space:]]*=/{print $2; exit}' "$repo/Cargo.toml")"
    version_json="$("$bin" version 2>/dev/null)" || return 1
    actual_version="$(json_field "$version_json" data.version)"
    clap_version="$("$bin" --version 2>/dev/null)" || return 1
    if [ -z "$expected_version" ] || [ "$actual_version" != "$expected_version" ] || \
        [ "$clap_version" != "agent-desktop $expected_version" ]; then
        echo "binary version identity mismatch: cargo='$expected_version' JSON='$actual_version' clap='$clap_version'" >&2
        return 1
    fi

    existing="$(pgrep -x "$app" 2>/dev/null || true)"
    if [ -n "$existing" ]; then
        echo "SKIP (blocked): native E2E contention; $app already has process(es): $existing" >&2
        contaminated=1
        return 1
    fi
    printf '  immutable binary: %s  sha256=%s  version=%s\n' "$raw_bin" "$raw_bin_sha" "$actual_version"
}

record_fixture_process() {
    fixture_pid="$(pgrep -x "$app" 2>/dev/null || true)"
    case "$fixture_pid" in
        ''|*' '*)
            echo "fixture process identity was missing or ambiguous: '${fixture_pid:-none}'" >&2
            contaminated=1
            return 1
            ;;
    esac
    if printf '%s' "$fixture_pid" | grep -q '[[:space:]]'; then
        echo "multiple fixture processes detected: $fixture_pid" >&2
        contaminated=1
        return 1
    fi
    fixture_started=1
}

check_fixture_contention() {
    local current
    current="$(pgrep -x "$app" 2>/dev/null || true)"
    if [ "$fixture_started" -ne 1 ] || [ "$current" != "$fixture_pid" ]; then
        badmsg "native E2E fixture ownership changed; expected pid '$fixture_pid', found '${current:-none}'"
        contaminated=1
        return 1
    fi
}

note() { printf '\n\033[1;34m== %s ==\033[0m\n' "$1"; }
okmsg() { printf '  \033[0;32mPASS\033[0m %s\n' "$1"; pass=$((pass + 1)); }
badmsg() {
    printf '  \033[0;31mFAIL\033[0m %s\n' "$1"
    fail=$((fail + 1))
    failures+=("$1")
}
skipmsg() {
    printf '  \033[0;33mSKIP\033[0m %s\n' "$1"
    skip=$((skip + 1))
    skips+=("$1")
}

abort_suite() {
    badmsg "$1"
    finish || true
    exit 1
}
assert() {
    if [ "$2" = "1" ]; then
        okmsg "$1  [$3]"
    else
        badmsg "$1  [$3]"
    fi
}

json_field() { printf '%s' "$1" | python3 "$json_tool" get "$2" 2>/dev/null; }
target_ref() { printf '%s' "${1%%$'\t'*}"; }
target_snapshot() { printf '%s' "${1#*$'\t'}"; }

find_target() {
    local role="$1" name="$2" output value
    for _ in $(seq 1 25); do
        output="$("$bin" find --app "$app" --role "$role" --name "$name" --first 2>/dev/null)"
        if [ -n "$output" ]; then
            value="$(printf '%s' "$output" | python3 "$json_tool" target 2>/dev/null)"
            if [ -n "$value" ]; then
                printf '%s' "$value"
                return 0
            fi
        fi
        sleep 0.2
    done
    printf 'find_target %s %s last output: %s\n' "$role" "$name" "$output" >&2
    return 1
}

find_target_by_id() {
    local role="$1" native_id="$2" output value
    for _ in $(seq 1 25); do
        if output="$("$bin" find --app "$app" --role "$role" --native-id "$native_id" --first 2>/dev/null)"; then
            value="$(printf '%s' "$output" | python3 "$json_tool" target 2>/dev/null)"
            if [ -n "$value" ]; then
                printf '%s' "$value"
                return 0
            fi
        fi
        sleep 0.2
    done
    return 1
}

require_target() {
    local variable="$1" role="$2" name="$3" value
    value="$(find_target "$role" "$name")" || {
        abort_suite "required fixture target '$name' ($role) is missing or lacks ref_id + snapshot_id"
    }
    printf -v "$variable" '%s' "$value"
}

require_target_by_id() {
    local variable="$1" role="$2" native_id="$3" value
    value="$(find_target_by_id "$role" "$native_id")" || {
        abort_suite "required fixture target '$native_id' ($role) is missing or lacks ref_id + snapshot_id"
    }
    printf -v "$variable" '%s' "$value"
}

find_value() {
    local name="$1" output value
    for _ in $(seq 1 25); do
        if output="$("$bin" find --app "$app" --role statictext --native-id "$name" --first 2>/dev/null)" \
            && value="$(printf '%s' "$output" | python3 "$json_tool" match-value 2>/dev/null)"; then
            printf '%s' "$value"
            return 0
        fi
        sleep 0.2
    done
    return 1
}

require_value() {
    local variable="$1" name="$2" value
    value="$(find_value "$name")" || {
        abort_suite "required fixture status '$name' is missing"
    }
    printf -v "$variable" '%s' "$value"
}

await_value() {
    local name="$1" expected="$2" value=""
    for _ in $(seq 1 25); do
        if value="$(find_value "$name")" && [ "$value" = "$expected" ]; then
            printf '%s' "$value"
            return 0
        fi
        sleep 0.2
    done
    printf '%s' "$value"
    return 1
}

assert_error_envelope() {
    local label="$1" expected_code="$2" expected_exit="$3" expected_delivery="$4"
    shift 4
    local ok code delivery delivery_ok=1
    run_timed "$bin" "$@"
    ok="$(json_field "$RUN_JSON" ok)"
    code="$(json_field "$RUN_JSON" error.code)"
    delivery="$(json_field "$RUN_JSON" error.disposition.delivery)"
    if [ -n "$expected_delivery" ] && [ "$delivery" != "$expected_delivery" ]; then delivery_ok=0; fi
    assert "$label" \
        "$([ "$RUN_EXIT" = "$expected_exit" ] && [ "$ok" = "False" ] && [ "$code" = "$expected_code" ] && [ "$delivery_ok" = "1" ] && echo 1 || echo 0)" \
        "exit=$RUN_EXIT ok=$ok code=$code delivery=$delivery args=$*"
}

act() {
    if [ -n "$MODE_FLAG" ]; then
        "$bin" "$MODE_FLAG" "$@"
    else
        "$bin" "$@"
    fi
}

act_target() {
    local target="$1" command="$2"
    shift 2
    act "$command" "$(target_ref "$target")" "$@"
}

get_target() {
    local target="$1"
    shift
    "$bin" get "$(target_ref "$target")" "$@"
}

is_target() {
    local target="$1" property="$2"
    "$bin" is "$(target_ref "$target")" --property "$property"
}

wait_target() {
    local target="$1" predicate="$2" timeout="$3"
    shift 3
    "$bin" wait --element "$(target_ref "$target")" \
        --predicate "$predicate" --timeout "$timeout" "$@"
}

verify() {
    local label="$1" status="$2" expected="$3" expected_mechanism="$4" target="$5" command="$6"
    shift 6
    local before after output command_ok error mechanism
    require_value before "$status"
    output="$(act_target "$target" "$command" "$@" 2>/dev/null)"
    sleep 0.35
    require_value after "$status"
    command_ok="$(json_field "$output" ok)"
    error="$(json_field "$output" error.code)"
    mechanism="$(printf '%s' "$output" | python3 "$json_tool" delivered-mechanism 2>/dev/null)"
    assert "$label" "$([ "$after" = "$expected" ] && [ "$command_ok" = "True" ] && [ "$mechanism" = "$expected_mechanism" ] && echo 1 || echo 0)" \
        "before='$before' after='$after' expected='$expected' ok=$command_ok mechanism=$mechanism${error:+ error=$error}"
}

run_timed() {
    local output_file metadata
    output_file="$(mktemp -t agentdesk-e2e-command.XXXXXX)"
    cleanup_files+=("$output_file")
    metadata="$(AGENT_DESKTOP_E2E_INHERIT_LEASE=1 \
        python3 "$json_tool" run "$output_file" "$@")"
    RUN_EXIT="${metadata%%$'\t'*}"
    RUN_MS="${metadata#*$'\t'}"
    RUN_JSON="$(<"$output_file")"
}

elapsed_in_range() {
    python3 - "$1" "$2" "$3" <<'PY'
import sys
value, lower, upper = map(float, sys.argv[1:])
print(1 if lower <= value <= upper else 0)
PY
}

running() {
    "$bin" list-apps --app "$app" 2>/dev/null | python3 -c \
        'import json,sys; d=json.load(sys.stdin); print(any(a.get("name") == "AgentDeskFixture" for a in d.get("data",{}).get("apps",[])))' \
        2>/dev/null
}

cleanup() {
    if [ "$fixture_owned" -eq 1 ] && [ -x "$bin" ]; then
        "$bin" close-app "$app" --force >/dev/null 2>&1 || true
    fi
    for file in "${cleanup_files[@]}"; do
        remove_artifact "$file" || true
    done
    if [ -n "$raw_bin" ] && ! verify_immutable_binary "$raw_bin" "$raw_bin_sha"; then
        contaminated=1
    fi
    if [ -n "$ffi_dylib" ] && ! verify_immutable_binary "$ffi_dylib" "$ffi_dylib_sha"; then
        contaminated=1
    fi
    if [ -n "$ffi_helper" ] && ! verify_immutable_binary "$ffi_helper" "$ffi_helper_sha"; then
        contaminated=1
    fi
    cleanup_isolated_environment
    release_exclusive_lock
}

finish() {
    note "Summary"
    if [ -n "$raw_bin" ] && ! verify_immutable_binary "$raw_bin" "$raw_bin_sha"; then
        contaminated=1
        badmsg "immutable release binary identity changed during the suite"
    fi
    if [ -n "$ffi_dylib" ] && ! verify_immutable_binary "$ffi_dylib" "$ffi_dylib_sha"; then
        contaminated=1
        badmsg "immutable release FFI library identity changed during the suite"
    fi
    if [ -n "$ffi_helper" ] && ! verify_immutable_binary "$ffi_helper" "$ffi_helper_sha"; then
        contaminated=1
        badmsg "immutable release FFI helper identity changed during the suite"
    fi
    printf '  passed: %d  failed: %d  skipped: %d\n' "$pass" "$fail" "$skip"
    if [ "$fail" -gt 0 ] || [ "$contaminated" -ne 0 ]; then
        printf '\n  failures:\n'
        local failure
        for failure in "${failures[@]}"; do
            printf '   - %s\n' "$failure"
        done
        if [ "$contaminated" -ne 0 ]; then
            printf '   - run was contaminated; no success claim is valid\n'
        fi
        return 1
    fi
    if [ "$skip" -gt 0 ]; then
        printf '\n  capability skips:\n'
        local skipped
        for skipped in "${skips[@]}"; do
            printf '   - %s\n' "$skipped"
        done
    fi
    echo "  all asserted E2E scenarios passed"
}
