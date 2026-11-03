note "Removed elements fail closed with their original namespace"
require_target reset_row button reset-removable
act_target "$reset_row" click >/dev/null 2>&1
sleep 0.2
require_target stale_row button removable-row
require_target remove_row button remove-row
act_target "$remove_row" click >/dev/null 2>&1
row_gone=0
for _ in $(seq 1 25); do
    removed_probe="$("$bin" find --app "$app" --role button --name removable-row --first 2>/dev/null | python3 "$json_tool" target 2>/dev/null || true)"
    if [ -z "$removed_probe" ]; then
        row_gone=1
        break
    fi
    sleep 0.2
done
stale_output="$(act_target "$stale_row" click --timeout-ms 1000 2>/dev/null)"
stale_code="$(json_field "$stale_output" error.code)"
stale_delivery="$(json_field "$stale_output" error.disposition.delivery)"
assert "removed target is refused as STALE_REF and never delivered" \
    "$([ "$row_gone" = "1" ] && [ "$(json_field "$stale_output" ok)" = "False" ] && [ "$stale_code" = "STALE_REF" ] && [ "$stale_delivery" = "not_delivered" ] && echo 1 || echo 0)" \
    "row_gone=$row_gone ref=$(target_ref "$stale_row") snapshot=$(target_snapshot "$stale_row") error=$stale_code delivery=$stale_delivery"

note "Wait predicates use exact element namespaces"
require_target reset_delayed button reset-delayed-button
act_target "$reset_delayed" click >/dev/null 2>&1
require_target delayed button delayed-button
require_target enable_later button enable-later
act_target "$enable_later" click >/dev/null 2>&1
wait_enabled="$(wait_target "$delayed" enabled 5000 2>/dev/null)"
enabled_read="$(is_target "$delayed" enabled 2>/dev/null)"
assert "wait enabled observes the asynchronous transition" \
    "$([ "$(json_field "$wait_enabled" ok)" = "True" ] && \
        [ "$(json_field "$wait_enabled" data.found)" = "True" ] && \
        [ "$(json_field "$enabled_read" data.result)" = "True" ] && echo 1 || echo 0)" \
    "elapsed_ms=$(json_field "$wait_enabled" data.elapsed_ms)"

require_target primary button primary-button
require_value actionable_before click-status
wait_actionable="$(wait_target "$primary" actionable 3000 --action click 2>/dev/null)"
actionable_click="$(act_target "$primary" click 2>/dev/null)"
sleep 0.35
require_value actionable_after click-status
case "$actionable_before" in
    idle) actionable_before_count=0 ;;
    *) actionable_before_count="${actionable_before##*-}" ;;
esac
actionable_after_count="${actionable_after##*-}"
case "$actionable_before_count" in *[!0-9]*|'') actionable_before_count=-1 ;; esac
case "$actionable_after_count" in *[!0-9]*|'') actionable_after_count=-1 ;; esac
assert "wait actionable evaluates the requested click policy" \
    "$([ "$(json_field "$wait_actionable" data.found)" = "True" ] && \
        [ "$(json_field "$actionable_click" ok)" = "True" ] && \
        [ "$actionable_after_count" -eq $((actionable_before_count + 1)) ] && echo 1 || echo 0)" \
    "before=$actionable_before after=$actionable_after click_ok=$(json_field "$actionable_click" ok) observed=$(json_field "$wait_actionable" data.observed)"
wait_visible="$(wait_target "$primary" visible 3000 2>/dev/null)"
visible_read="$(is_target "$primary" visible 2>/dev/null)"
assert "wait visible succeeds for the primary button" \
    "$([ "$(json_field "$wait_visible" data.found)" = "True" ] && \
        [ "$(json_field "$visible_read" data.result)" = "True" ] && echo 1 || echo 0)" \
    "observed=$(json_field "$wait_visible" data.observed)"

require_target text_input textfield text-input
act_target "$text_input" set-value pred-val >/dev/null 2>&1
sleep 0.3
require_target text_input textfield text-input
wait_value="$(wait_target "$text_input" value 3000 --value pred-val 2>/dev/null)"
value_read="$(get_target "$text_input" --property value 2>/dev/null)"
assert "wait value observes the exact live value" \
    "$([ "$(json_field "$wait_value" data.found)" = "True" ] && \
        [ "$(json_field "$wait_value" data.observed.matched)" = "True" ] && \
        [ "$(json_field "$value_read" data.value)" = "pred-val" ] && echo 1 || echo 0)" \
    "observed=$(json_field "$wait_value" data.observed)"

note "Text and post-action selector waits"
require_target reset_appeared button reset-appeared-text
act_target "$reset_appeared" click >/dev/null 2>&1
require_target appear_later button appear-later
act_target "$appear_later" click >/dev/null 2>&1
wait_text="$("$bin" wait --text appeared-text --app "$app" --timeout 5000 2>/dev/null)"
assert "wait text resolves asynchronous appearance" \
    "$([ "$(json_field "$wait_text" data.found)" = "True" ] && echo 1 || echo 0)" \
    "elapsed_ms=$(json_field "$wait_text" data.elapsed_ms)"

require_target reset_appeared button reset-appeared-text
act_target "$reset_appeared" click >/dev/null 2>&1
require_target appear_later button appear-later
wait_for_output="$(act_target "$appear_later" click -w ":appeared-text" --wait-timeout 8000 2>/dev/null)"
assert "post-action selector waits for asynchronous text" \
    "$([ "$(json_field "$wait_for_output" ok)" = "True" ] && \
        [ "$(json_field "$wait_for_output" data.matched_selector)" = ":appeared-text" ] && \
        [ "$(json_field "$wait_for_output" data.after_action.action)" = "click" ] && echo 1 || echo 0)" \
    "matched=$(json_field "$wait_for_output" data.matched_selector)"

require_target reset_row button reset-removable
act_target "$reset_row" click >/dev/null 2>&1
require_target remove_row button remove-row
wait_gone="$(act_target "$remove_row" click --wait-for-gone "button:removable-row" --wait-timeout 5000 2>/dev/null)"
assert "post-action wait-for-gone observes removal" \
    "$([ "$(json_field "$wait_gone" ok)" = "True" ] && \
        [ "$(json_field "$wait_gone" data.matched_selector)" = "button:removable-row" ] && echo 1 || echo 0)" \
    "matched=$(json_field "$wait_gone" data.matched_selector) ok=$(json_field "$wait_gone" ok) err=$(json_field "$wait_gone" error.code) kind=$(json_field "$wait_gone" error.details.kind)"

run_timed "$bin" snapshot --app "$app" -w ":does-not-exist-xyz" --wait-timeout 400
timeout_kind="$(json_field "$RUN_JSON" error.details.kind)"
timeout_snapshot="$(json_field "$RUN_JSON" error.details.snapshot_id)"
assert "selector timeout has structured recovery evidence" \
    "$([ "$RUN_EXIT" -ne 0 ] && [ "$timeout_kind" = "wait_timeout" ] && \
        [ "$(json_field "$RUN_JSON" error.details.predicate)" = "selector" ] && \
        [ -n "$timeout_snapshot" ] && echo 1 || echo 0)" \
    "elapsed_ms=$RUN_MS kind=$timeout_kind snapshot=$timeout_snapshot"

find_wait="$("$bin" find --app "$app" -w "button:OK" 2>/dev/null)"
assert "commands without post-action wait support reject -w" \
    "$([ "$(json_field "$find_wait" error.code)" = "INVALID_ARGS" ] && echo 1 || echo 0)" \
    "error=$(json_field "$find_wait" error.code)"

note "Skeleton traversal, drill-down, and session namespaces"
skeleton="$("$bin" snapshot --app "$app" --skeleton 2>/dev/null)"
skeleton_id="$(json_field "$skeleton" data.snapshot_id)"
skeleton_refs="$(json_field "$skeleton" data.ref_count)"
anchor="$(printf '%s' "$skeleton" | python3 "$json_tool" drill-anchor 2>/dev/null)" || anchor=""
if [ -z "$anchor" ] || [ -z "$skeleton_id" ]; then
    abort_suite "skeleton did not expose a drill-down anchor and snapshot_id"
fi
drill="$("$bin" snapshot --app "$app" --root "$anchor" 2>/dev/null)"
drilled_refs="$(json_field "$drill" data.ref_count)"
assert "skeleton drill-down stays pinned to its source snapshot" \
    "$([ "$(json_field "$drill" ok)" = "True" ] && [ "$drilled_refs" -gt 0 ] && echo 1 || echo 0)" \
    "skeleton_refs=$skeleton_refs anchor=$anchor drilled_refs=$drilled_refs"

session_a="$("$bin" --session run-a snapshot --app "$app" 2>/dev/null)"
session_a_id="$(json_field "$session_a" data.snapshot_id)"
session_b="$("$bin" --session run-b snapshot --app "$app" 2>/dev/null)"
session_b_id="$(json_field "$session_b" data.snapshot_id)"
assert "sessions produce distinct latest snapshot ids" \
    "$([ -n "$session_a_id" ] && [ -n "$session_b_id" ] && [ "$session_a_id" != "$session_b_id" ] && echo 1 || echo 0)" \
    "run-a=$session_a_id run-b=$session_b_id"
session_ref="$(printf '%s' "$session_a" | python3 "$json_tool" tree primary-button ref 2>/dev/null)" || session_ref=""
if [ -z "$session_ref" ]; then
    abort_suite "session-a snapshot omitted primary-button ref"
fi
session_get="$("$bin" --session run-a get "$session_ref" --property role 2>/dev/null)"
assert "explicit session snapshot resolves within its owning session" \
    "$([ "$(json_field "$session_get" ok)" = "True" ] && echo 1 || echo 0)" \
    "ref=$session_ref snapshot=$session_a_id value=$(json_field "$session_get" data.value) err=$(json_field "$session_get" error.code)"
