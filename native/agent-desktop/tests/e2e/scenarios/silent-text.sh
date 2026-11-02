find_target silent_field textfield silent-text-input || fail "silent text fixture is not uniquely addressable"
safety_checkpoint || fail "ownership checkpoint failed before silent setter"
silent_output="$(agent_exec 1 type "$(target_ref "$silent_field")" "safe-semantic-must-not-disappear" \
    --timeout-ms 1500 2>"$suite_root/silent-text.stderr")"
silent_exit=$?
printf '%s' "$silent_output" > "$suite_root/silent-text.json"
[ "$silent_exit" -eq 1 ] || fail "silent setter must return a structured error (exit=$silent_exit): $silent_output"
[ "$(json_field "$silent_output" error.code)" = "ACTION_FAILED" ] || fail "silent setter error code is incorrect: $silent_output"
[ "$(json_field "$silent_output" error.disposition.retry)" = "unsafe" ] || fail "silent setter must forbid blind retry"
silent_state="$(agent_exec 0 get "$(target_ref "$silent_field")" \
    --property value)" \
    || fail "silent setter readback failed"
printf '%s' "$silent_state" | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d["ok"] and d["data"]["value"] == ""' \
    || fail "silent fixture readback was unexpected: $silent_state"
safety_checkpoint || fail "ownership checkpoint failed after silent setter"
pass "AXSelectedText silent no-op is rejected without retry or focus stealing"
