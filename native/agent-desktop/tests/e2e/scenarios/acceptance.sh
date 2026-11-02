run_ref_timed() {
    local mode="$1" target="$2"
    shift 2
    if [ "$mode" = "headed" ]; then
        run_timed "$bin" --headed click "$(target_ref "$target")" \
            "$@"
    else
        run_timed "$bin" click "$(target_ref "$target")" \
            "$@"
    fi
}

assert_actionability_timeout() {
    local label="$1" lower="$2" upper="$3"
    local code kind last_report timing_ok
    code="$(json_field "$RUN_JSON" error.code)"
    kind="$(json_field "$RUN_JSON" error.details.kind)"
    last_report="$(json_field "$RUN_JSON" error.details.last_report)"
    timing_ok="$(elapsed_in_range "$RUN_MS" "$lower" "$upper")"
    assert "$label" \
        "$([ "$RUN_EXIT" -ne 0 ] && [ "$code" = "TIMEOUT" ] && \
            [ "$kind" = "actionability_timeout" ] && [ -n "$last_report" ] && \
            [ "$timing_ok" = "1" ] && echo 1 || echo 0)" \
        "exit=$RUN_EXIT elapsed_ms=$RUN_MS code=$code kind=$kind last_report=${last_report:0:100}"
}

note "AE1: zero-sized element is not visible"
require_target zero_target button zero-bounds-button
zero_visible="$(is_target "$zero_target" visible 2>/dev/null)"
assert "AE1 qualified zero-bounds ref reports visible false" \
    "$([ "$(json_field "$zero_visible" ok)" = "True" ] && \
        [ "$(json_field "$zero_visible" data.applicable)" = "True" ] && \
        [ "$(json_field "$zero_visible" data.result)" = "False" ] && echo 1 || echo 0)" \
    "ref=$(target_ref "$zero_target") snapshot=$(target_snapshot "$zero_target") applicable=$(json_field "$zero_visible" data.applicable) result=$(json_field "$zero_visible" data.result) error=$(json_field "$zero_visible" error.code)"

for mode in headless headed; do
    note "AE2, AE3, AE7: action auto-wait ($mode)"
    require_target permanent button permanently-disabled
    require_value disabled_before delayed-action-status

    run_ref_timed "$mode" "$permanent"
    assert_actionability_timeout "AE7 $mode default timeout remains approximately 5 seconds" 4400 6800
    require_value disabled_after_default delayed-action-status
    assert "AE7 $mode timeout never dispatches" \
        "$([ "$disabled_after_default" = "$disabled_before" ] && echo 1 || echo 0)" \
        "before=$disabled_before after=$disabled_after_default"

    require_target permanent button permanently-disabled
    run_ref_timed "$mode" "$permanent" --timeout-ms 2000
    assert_actionability_timeout "AE3 $mode explicit timeout is approximately 2 seconds" 1600 3300
    require_value disabled_after_explicit delayed-action-status
    assert "AE3 $mode timeout never dispatches" \
        "$([ "$disabled_after_explicit" = "$disabled_before" ] && echo 1 || echo 0)" \
        "before=$disabled_before after=$disabled_after_explicit"

    require_target permanent button permanently-disabled
    run_ref_timed "$mode" "$permanent" --timeout-ms 0
    zero_actionable="$(json_field "$RUN_JSON" error.details.actionable)"
    zero_checks="$(json_field "$RUN_JSON" error.details.checks)"
    zero_timing="$(elapsed_in_range "$RUN_MS" 0 900)"
    assert "AE2 $mode timeout-ms=0 is one immediate actionability check" \
        "$([ "$RUN_EXIT" -ne 0 ] && [ "$zero_actionable" = "False" ] && \
            [ -n "$zero_checks" ] && [ "$zero_timing" = "1" ] && echo 1 || echo 0)" \
        "exit=$RUN_EXIT elapsed_ms=$RUN_MS code=$(json_field "$RUN_JSON" error.code) checks=${zero_checks:0:100}"

    require_target reset_delayed button reset-delayed-button
    reset_output="$(act_target "$reset_delayed" click 2>/dev/null)"
    sleep 0.25
    require_value reset_count delayed-action-status
    require_value reset_state delayed-text
    assert "AE2 $mode delayed fixture reset" \
        "$([ "$(json_field "$reset_output" ok)" = "True" ] && [ "$reset_count" = "0" ] && \
            [ "$reset_state" = "waiting" ] && echo 1 || echo 0)" \
        "count=$reset_count state=$reset_state"

    require_target delayed button delayed-button
    require_target enable_later button enable-later
    act_target "$enable_later" click >/dev/null 2>&1
    run_ref_timed "$mode" "$delayed"
    delayed_timing="$(elapsed_in_range "$RUN_MS" 500 2800)"
    sleep 0.5
    require_value delayed_count delayed-action-status
    assert "AE2 $mode default auto-wait succeeds after delayed enable exactly once" \
        "$([ "$RUN_EXIT" -eq 0 ] && [ "$(json_field "$RUN_JSON" ok)" = "True" ] && \
            [ "$delayed_timing" = "1" ] && [ "$delayed_count" = "1" ] && echo 1 || echo 0)" \
        "exit=$RUN_EXIT elapsed_ms=$RUN_MS count_after_settle=$delayed_count"
done

note "AE2: native release FFI consumer preserves wait and namespace semantics"
ffi_default="$(guard_agent_wrapper_exec 20 4194304 python3 "$here/ffi_live.py" default 2>/dev/null)"
ffi_default_exit=$?
sleep 0.2
require_value ffi_default_count delayed-action-status
assert "AE2 release FFI default wait dispatches exactly once" \
    "$([ "$ffi_default_exit" -eq 0 ] && [ "$(json_field "$ffi_default" ok)" = "True" ] && \
        [ "$ffi_default_count" = "1" ] && echo 1 || echo 0)" \
    "exit=$ffi_default_exit elapsed_ms=$(json_field "$ffi_default" elapsed_ms) count=$ffi_default_count error=$(json_field "$ffi_default" error)"
ffi_zero="$(guard_agent_wrapper_exec 20 4194304 python3 "$here/ffi_live.py" zero 2>/dev/null)"
ffi_zero_exit=$?
require_value ffi_zero_count delayed-action-status
assert "AE2 release FFI timeout zero performs one check without a late effect" \
    "$([ "$ffi_zero_exit" -eq 0 ] && [ "$(json_field "$ffi_zero" ok)" = "True" ] && \
        [ "$ffi_zero_count" = "0" ] && echo 1 || echo 0)" \
    "exit=$ffi_zero_exit elapsed_ms=$(json_field "$ffi_zero" elapsed_ms) code=$(json_field "$ffi_zero" zero_code) count_after_settle=$ffi_zero_count error=$(json_field "$ffi_zero" error)"

note "AE4: duplicate-title windows honor exact window id"
require_target open_duplicates button open-duplicate-windows
open_output="$(act_target "$open_duplicates" click 2>/dev/null)"
sleep 0.8
windows_json="$("$bin" list-windows --app "$app" 2>/dev/null)"
duplicate_ids="$(printf '%s' "$windows_json" | python3 "$json_tool" duplicate-ids "Duplicate Window" 2>/dev/null)" || duplicate_ids=""
if [ -z "$duplicate_ids" ]; then
    abort_suite "AE4 fixture did not expose exactly two distinct Duplicate Window ids"
fi
first_duplicate="${duplicate_ids%%$'\t'*}"
second_duplicate="${duplicate_ids#*$'\t'}"
focus_output="$("$bin" focus-window --window-id "$second_duplicate" 2>/dev/null)"
sleep 0.3
focused_windows="$("$bin" list-windows --app "$app" 2>/dev/null)"
second_focused="$(printf '%s' "$focused_windows" | python3 "$json_tool" window-focused "$second_duplicate" 2>/dev/null)" || second_focused=""
assert "AE4 exact second window id is focused despite duplicate titles" \
    "$([ "$(json_field "$open_output" ok)" = "True" ] && \
        [ "$(json_field "$focus_output" ok)" = "True" ] && [ "$second_focused" = "True" ] && echo 1 || echo 0)" \
    "first=$first_duplicate second=$second_duplicate second_focused=$second_focused"
"$bin" focus-window --app "$app" --title "AgentDesk Fixture" >/dev/null 2>&1
require_target close_duplicates button close-duplicate-windows
act_target "$close_duplicates" click >/dev/null 2>&1

note "AE5: deterministic and native denied-permission contracts"
permission_contract="$(guard_exec 620 4194304 bash "$here/permission-contract.sh" 2>/dev/null)"
permission_exit=$?
assert "AE5 permission prompts are isolated and Automation probing never prompts" \
    "$([ "$permission_exit" -eq 0 ] && [ "$(json_field "$permission_contract" ok)" = "True" ] && echo 1 || echo 0)" \
    "exit=$permission_exit kind=$(json_field "$permission_contract" data.kind) error=$(json_field "$permission_contract" error.code)"

permission_json="$("$bin" permissions 2>/dev/null)"
automation_state="$(json_field "$permission_json" data.automation.state)"
if [ "$(json_field "$permission_json" ok)" != "True" ] || [ -z "$automation_state" ]; then
    badmsg "AE5 native permission state could not be read"
elif [ "$automation_state" = "denied" ]; then
    nc_probe="$("$bin" list-notifications 2>/dev/null)"
    if [ "$(json_field "$nc_probe" ok)" = "True" ]; then
        "$bin" focus-window --app NotificationCenter >/dev/null 2>&1 || true
        "$bin" --headed press escape >/dev/null 2>&1 || true
        sleep 0.3
        nc_probe="$("$bin" list-notifications 2>/dev/null)"
    fi
    if [ "$(json_field "$nc_probe" error.code)" != "POLICY_DENIED" ]; then
        skipmsg "AE5 native denied-Automation path unavailable: Notification Center could not be proven closed after best-effort preparation; deterministic contract still ran"
    else
        denied_output="$("$bin" --headed list-notifications 2>/dev/null)"
        denied_code="$(json_field "$denied_output" error.code)"
        denied_suggestion="$(json_field "$denied_output" error.suggestion)"
        suggestion_has_automation=0
        case "$denied_suggestion" in
            *Automation*) suggestion_has_automation=1 ;;
        esac
        assert "AE5 headed Notification Center rejects denied Automation before AppleScript" \
            "$([ "$denied_code" = "PERM_DENIED" ] && \
                [ "$suggestion_has_automation" -eq 1 ] && echo 1 || echo 0)" \
            "state=$automation_state code=$denied_code suggestion=$denied_suggestion"
    fi
else
    skipmsg "AE5 native denied-Automation path unavailable: current TCC state is ${automation_state:-unknown}; deterministic contract still ran"
fi

note "AE6: post-action surface event uses a pre-action baseline"
open_sheet_ref="$(printf '%s' "$snapshot_json" | python3 "$json_tool" tree open-sheet ref 2>/dev/null)" || open_sheet_ref=""
open_sheet_snapshot="$(json_field "$snapshot_json" data.snapshot_id)"
if [ -z "$open_sheet_ref" ] || [ -z "$open_sheet_snapshot" ]; then
    abort_suite "initial fixture snapshot omitted the open-sheet ref"
fi
open_sheet="${open_sheet_ref}"$'\t'"${open_sheet_snapshot}"
sheet_scroll_output="$(act_target "$open_sheet" scroll-to 2>/dev/null)"
batch_payload="$(python3 - "$(target_ref "$open_sheet")" <<'PY'
import json, sys
print(json.dumps([
    {"command": "click", "args": {"ref_id": sys.argv[1]}},
    {"command": "wait", "args": {"event": "surface-appeared", "app": "AgentDeskFixture", "timeout": 5000}},
]))
PY
)"
surface_batch="$("$bin" batch "$batch_payload" --stop-on-error 2>/dev/null)"
surface_kind="$(json_field "$surface_batch" data.results.1.data.event.kind)"
surface_type="$(json_field "$surface_batch" data.results.1.data.event.surface)"
assert "AE6 synchronous click reports the newly appeared unnamed surface" \
    "$([ "$(json_field "$surface_batch" ok)" = "True" ] && \
        [ "$(json_field "$surface_batch" data.results.0.ok)" = "True" ] && \
        [ "$(json_field "$surface_batch" data.results.1.ok)" = "True" ] && \
        [ "$surface_kind" = "surface_appeared" ] && \
        [ "$surface_type" = "sheet" ] && echo 1 || echo 0)" \
    "kind=$surface_kind surface=$surface_type app=$(json_field "$surface_batch" data.results.1.data.event.app) scrollto_ok=$(json_field "$sheet_scroll_output" ok) scrollto_code=$(json_field "$sheet_scroll_output" error.code) batch_ok=$(json_field "$surface_batch" ok) r0_ok=$(json_field "$surface_batch" data.results.0.ok) r0_code=$(json_field "$surface_batch" data.results.0.error.code) r1_ok=$(json_field "$surface_batch" data.results.1.ok) r1_code=$(json_field "$surface_batch" data.results.1.error.code) batch_err=$(json_field "$surface_batch" error.code)"
require_target cancel_sheet button cancel-sheet
act_target "$cancel_sheet" click >/dev/null 2>&1
