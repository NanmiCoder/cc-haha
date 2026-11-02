note "Default CLI retains native identity across collection changes"
MODE_FLAG=""
AGENT_DESKTOP_FIXTURE_REF_CHURN=1 AGENT_DESKTOP_FIXTURE_NO_ACTIVATE=1 \
    "$fixture_app/Contents/MacOS/AgentDeskFixture" >/dev/null 2>&1 &
churn_pid=$!
fixture_owned=1
require_target_by_id filter button filter-rows
require_target_by_id alpha textfield shared-title
require_target_by_id stable textfield stable-editor
act_target "$filter" click >/dev/null 2>&1
"$bin" wait --text "Restore rows" --app "$app" --timeout 5000 >/dev/null 2>&1
output="$("$bin" set-value "$(target_ref "$alpha")" poisoned 2>/dev/null)"
ok="$(json_field "$output" ok)"
code="$(json_field "$output" error.code)"
delivery="$(json_field "$output" error.disposition.delivery)"
assert "removed row is refused without delivery" \
    "$([ "$ok" = "False" ] && [ "$code" = "STALE_REF" ] && [ "$delivery" = "not_delivered" ] && echo 1 || echo 0)" \
    "ok=$ok code=$code delivery=$delivery"
batch_payload="$(python3 - "$(target_ref "$alpha")" <<'BATCH_PY'
import json, sys
print(json.dumps([{"command": "set-value", "args": {"ref_id": sys.argv[1], "value": "poisoned"}}]))
BATCH_PY
)"
batch_output="$("$bin" batch "$batch_payload" 2>/dev/null)"
assert "batch also refuses the removed row without delivery" \
    "$([ "$(json_field "$batch_output" data.results.0.error.code)" = "STALE_REF" ] && [ "$(json_field "$batch_output" data.results.0.error.disposition.delivery)" = "not_delivered" ] && echo 1 || echo 0)" \
    "code=$(json_field "$batch_output" data.results.0.error.code)"
beta_seen="$("$bin" wait --text "Beta stored: Beta" --app "$app" --timeout 3000 2>/dev/null)"
assert "surviving row kept its value" \
    "$([ "$(json_field "$beta_seen" data.found)" = "True" ] && echo 1 || echo 0)" \
    "found=$(json_field "$beta_seen" data.found)"
stable_write="$("$bin" set-value "$(target_ref "$stable")" stable-ok 2>/dev/null)"
stable_seen="$(wait_target "$stable" value 3000 --value stable-ok 2>/dev/null)"
assert "unchanged editor remains editable through its ref" \
    "$([ "$(json_field "$stable_write" ok)" = "True" ] && [ "$(json_field "$stable_seen" data.found)" = "True" ] && echo 1 || echo 0)" \
    "ok=$(json_field "$stable_write" ok) found=$(json_field "$stable_seen" data.found)"
pgrep -fx "$raw_bin" | while read -r host_pid; do
    kill "$host_pid" 2>/dev/null || true
done
for _ in $(seq 1 100); do
    [ -z "$(pgrep -fx "$raw_bin" 2>/dev/null)" ] && break
    sleep 0.02
done
assert "task-owned command hosts stopped" \
    "$([ -z "$(pgrep -fx "$raw_bin" 2>/dev/null)" ] && echo 1 || echo 0)" ""
restarted_read="$("$bin" get "$(target_ref "$stable")" 2>/dev/null)"
assert "host restart invalidates retained refs" \
    "$([ "$(json_field "$restarted_read" error.code)" = "STALE_REF" ] && echo 1 || echo 0)" \
    "code=$(json_field "$restarted_read" error.code)"
require_target_by_id fresh_stable textfield stable-editor
fresh_read="$("$bin" get "$(target_ref "$fresh_stable")" 2>/dev/null)"
assert "fresh snapshot after host restart restores access" \
    "$([ "$(json_field "$fresh_read" ok)" = "True" ] && echo 1 || echo 0)" \
    "ok=$(json_field "$fresh_read" ok)"
kill "$churn_pid" 2>/dev/null
wait "$churn_pid" 2>/dev/null
fixture_owned=0

note "Complete app inventory gives a terminal unknown-app response"
run_timed "$bin" snapshot --app "AgentDeskMissing-$churn_pid" --timeout-ms 1500
assert "unknown app is APP_NOT_FOUND without delivery" \
    "$([ "$(json_field "$RUN_JSON" error.code)" = "APP_NOT_FOUND" ] && [ "$(json_field "$RUN_JSON" error.disposition.delivery)" = "not_delivered" ] && echo 1 || echo 0)" \
    "exit=$RUN_EXIT elapsed=$RUN_MS code=$(json_field "$RUN_JSON" error.code)"
