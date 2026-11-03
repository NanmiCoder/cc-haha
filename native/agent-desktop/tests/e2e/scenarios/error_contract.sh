DUPLICATE_PID_DEFECT="known product defect: NSWorkspace listed one pid twice and the macOS app inventory refuses any list with a skipped record, so an unknown-app lookup times out instead of APP_NOT_FOUND (crates/macos/src/system/appkit_bridge.m duplicate_pid skip since 9d7ba42a; crates/macos/src/system/window/window_inventory_global_timeout.rs since 3f322728)"

inventory_duplicate_pid_refusal() {
    [ "$(json_field "$1" "$2.code")" = "TIMEOUT" ] && \
        [ "$(json_field "$1" "$2.details.kind")" = "global_window_inventory_unstable" ] && \
        [ "$(json_field "$1" "$2.details.skipped.0.field")" = "duplicate_pid" ]
}

error_contract_suite() {
    MODE_FLAG=""
    note "error envelopes: exit code and error.code an agent branches on"
    assert_error_envelope "bare @e1 is INVALID_ARGS, never delivered" INVALID_ARGS 1 not_delivered \
        click @e1
    assert_error_envelope "well-formed ref to an unknown snapshot is SNAPSHOT_NOT_FOUND" SNAPSHOT_NOT_FOUND 1 not_delivered \
        click @sdeadbeef:e1
    assert_error_envelope "closed alert surface is ELEMENT_NOT_FOUND" ELEMENT_NOT_FOUND 1 "" \
        snapshot --app "$app" --surface alert
    assert_error_envelope "missing required argument is a parse error, exit 2" INVALID_ARGS 2 "" \
        click
    run_timed "$bin" snapshot --app NoSuchApp12345 -i
    if inventory_duplicate_pid_refusal "$RUN_JSON" error; then
        skipmsg "unknown app is APP_NOT_FOUND: $DUPLICATE_PID_DEFECT"
        skipmsg "APP_NOT_FOUND carries the list-apps recovery hint: $DUPLICATE_PID_DEFECT"
    else
        assert "APP_NOT_FOUND carries the list-apps recovery hint" \
            "$(case "$(json_field "$RUN_JSON" error.suggestion)" in *list-apps*) echo 1 ;; *) echo 0 ;; esac)" \
            "suggestion=$(json_field "$RUN_JSON" error.suggestion)"
        assert_error_envelope "unknown app is APP_NOT_FOUND" APP_NOT_FOUND 1 not_delivered \
            snapshot --app NoSuchApp12345 -i
    fi
}

batch_payload_for() {
    python3 - "$1" "$2" "$3" <<'PY'
import json, sys
ref, tail, first_value = sys.argv[1:4]
malformed = {"command": "click", "args": {"ref_id": "@e1"}}
missing_app = {"command": "snapshot", "args": {"app": "NoSuchApp12345"}}
print(json.dumps([
    {"command": "set-value", "args": {"ref_id": ref, "value": first_value}},
    malformed if tail == "malformed" else missing_app,
    {"command": "set-value", "args": {"ref_id": ref, "value": "batch-last"}},
]))
PY
}

batch_failure_suite() {
    local field payload settled
    MODE_FLAG=""
    note "batch: continue by default, halt with --stop-on-error, reject malformed entries up front"
    require_target field textfield text-input
    act_target "$field" clear >/dev/null 2>&1
    require_target field textfield text-input
    payload="$(batch_payload_for "$(target_ref "$field")" runtime batch-first)"
    run_timed "$bin" batch "$payload"
    settled="$(json_field "$(get_target "$field" --property value)" data.value)"
    assert "batch continues past a failed entry by default" \
        "$([ "$RUN_EXIT" = "0" ] && [ "$(json_field "$RUN_JSON" ok)" = "True" ] && \
            [ "$(json_field "$RUN_JSON" data.results.1.ok)" = "False" ] && \
            { [ "$(json_field "$RUN_JSON" data.results.1.error.code)" = "APP_NOT_FOUND" ] || \
                inventory_duplicate_pid_refusal "$RUN_JSON" data.results.1.error; } && \
            [ "$(json_field "$RUN_JSON" data.results.2.ok)" = "True" ] && \
            [ "$(json_field "$RUN_JSON" data.completed_entries)" = "3" ] && \
            [ -z "$(json_field "$RUN_JSON" data.stopped)" ] && [ "$settled" = "batch-last" ] && echo 1 || echo 0)" \
        "exit=$RUN_EXIT r1=$(json_field "$RUN_JSON" data.results.1.error.code) r2_ok=$(json_field "$RUN_JSON" data.results.2.ok) readout=$settled"
    require_target field textfield text-input
    payload="$(batch_payload_for "$(target_ref "$field")" runtime batch-first)"
    run_timed "$bin" batch "$payload" --stop-on-error
    settled="$(json_field "$(get_target "$field" --property value)" data.value)"
    assert "batch --stop-on-error halts and the later write never lands" \
        "$([ "$RUN_EXIT" = "0" ] && [ "$(json_field "$RUN_JSON" data.stopped.reason)" = "stop_on_error" ] && \
            [ "$(json_field "$RUN_JSON" data.stopped.index)" = "1" ] && \
            [ "$(json_field "$RUN_JSON" data.completed_entries)" = "2" ] && \
            [ "$(json_field "$RUN_JSON" data.not_started_entries)" = "1" ] && \
            [ -z "$(json_field "$RUN_JSON" data.results.2.ok)" ] && [ "$settled" = "batch-first" ] && echo 1 || echo 0)" \
        "exit=$RUN_EXIT stopped=$(json_field "$RUN_JSON" data.stopped) readout=$settled"
    require_target field textfield text-input
    payload="$(batch_payload_for "$(target_ref "$field")" malformed batch-never)"
    run_timed "$bin" batch "$payload"
    assert "batch rejects a malformed entry before running any entry" \
        "$([ "$RUN_EXIT" = "1" ] && [ "$(json_field "$RUN_JSON" ok)" = "False" ] && \
            [ "$(json_field "$RUN_JSON" error.code)" = "INVALID_ARGS" ] && \
            [ "$(json_field "$RUN_JSON" error.details.batch_index)" = "1" ] && \
            [ "$(json_field "$(get_target "$field" --property value)" data.value)" = "batch-first" ] && echo 1 || echo 0)" \
        "exit=$RUN_EXIT code=$(json_field "$RUN_JSON" error.code) batch_index=$(json_field "$RUN_JSON" error.details.batch_index)"
}

error_contract_suite
batch_failure_suite
