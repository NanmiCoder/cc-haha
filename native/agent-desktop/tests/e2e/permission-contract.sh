#!/usr/bin/env bash
set -uo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
json_tool="$repo/tests/e2e/json_tool.py"
cd "$repo" || exit 2

test_output="$(AGENT_DESKTOP_E2E_TIMEOUT_SECONDS=300 \
    AGENT_DESKTOP_E2E_MAX_CAPTURE_BYTES=4194304 \
    python3 "$json_tool" exec scripts/cargo-test-isolated-home.sh test --locked --quiet --lib \
    -p agent-desktop-macos system::permissions::tests 2>&1)"
test_exit=$?
test_count="$(printf '%s' "$test_output" | grep -Eo '[0-9]+ passed' | tail -1 | awk '{print $1}')"
test_count="${test_count:-0}"

if [ "$test_exit" -eq 0 ] && [ "$test_count" -ge 3 ]; then
    printf '{"ok":true,"data":{"kind":"deterministic_permission_architecture_contract","permission_tests":%s,"automation":"nonprompting_probe","native_prompts":false}}\n' "$test_count"
    exit 0
fi

printf '{"ok":false,"error":{"code":"ACCEPTANCE_HELPER_FAILED","details":{"test_exit":%s,"tests":%s}}}\n' \
    "$test_exit" "$test_count"
exit 1
