press_expect() {
    local label="$1" combo="$2" expected="$3" output ok observed
    output="$("$bin" --headed press "$combo" --app "$app" 2>/dev/null)"
    ok="$(json_field "$output" ok)"
    observed="$(await_value text-echo "$expected")"
    assert "$label" \
        "$([ "$ok" = "True" ] && [ "$observed" = "$expected" ] && echo 1 || echo 0)" \
        "combo=$combo ok=$ok expected='$expected' observed='$observed' error=$(json_field "$output" error.code)"
}

press_suite() {
    local field
    MODE_FLAG="--headed"
    note "[headed] press delivers real key combos to the focused field"
    "$bin" focus-window --app "$app" >/dev/null 2>&1
    require_target field textfield text-input
    act_target "$field" clear >/dev/null 2>&1
    require_target field textfield text-input
    act_target "$field" focus >/dev/null 2>&1
    press_expect "press plain key types it" x x
    press_expect "press shift+letter types the capital" shift+y xY
    "$bin" --headed press cmd+a --app "$app" >/dev/null 2>&1
    press_expect "press cmd+a then delete empties the field" delete ""
    assert_error_envelope "press refuses a blocked combo before delivery" POLICY_DENIED 1 not_delivered \
        --headed press cmd+q --app "$app"
    check_fixture_contention || { finish; exit 1; }
    assert_error_envelope "press rejects an unknown modifier" INVALID_ARGS 1 not_delivered \
        press foo+x --app "$app"
    MODE_FLAG=""
}

press_suite
