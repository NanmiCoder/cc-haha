note "Observation and locator vocabulary"
snapshot_json="$("$bin" snapshot --app "$app" --max-depth 30 2>/dev/null)"
snapshot_ok="$(json_field "$snapshot_json" ok)"
ref_count="$(json_field "$snapshot_json" data.ref_count)"
assert "full snapshot succeeds" "$([ "$snapshot_ok" = "True" ] && echo 1 || echo 0)" \
    "ok=$snapshot_ok ref_count=$ref_count"

for role in button textfield checkbox combobox slider incrementor radiobutton disclosure link treeitem scrollarea; do
    role_count="$(printf '%s' "$snapshot_json" | grep -o "\"role\":\"$role\"" | wc -l | tr -d ' ')"
    assert "snapshot exposes role $role" "$([ "$role_count" -ge 1 ] && echo 1 || echo 0)" \
        "count=$role_count ref_count=$ref_count"
done

require_target text_input textfield text-input
okmsg "find textfield by accessible name returns ref_id + snapshot_id"

textarea_json="$("$bin" find --app "$app" --role textarea --name text-input --first 2>/dev/null)"
textarea_target="$(printf '%s' "$textarea_json" | python3 "$json_tool" target 2>/dev/null)" || textarea_target=""
assert "textarea alias resolves the textfield" "$([ -n "$textarea_target" ] && echo 1 || echo 0)" \
    "target='$(target_ref "$textarea_target")' snapshot='$(target_snapshot "$textarea_target")'"

hint_json="$("$bin" find --app "$app" --role toolbar 2>/dev/null)"
roles_present="$(json_field "$hint_json" data.roles_present)"
assert "absent role returns roles_present hint" "$([ -n "$roles_present" ] && echo 1 || echo 0)" \
    "roles_present=${roles_present:0:100}"

note "Exact find namespace survives later observations"
require_target namespaced_target button primary-button
namespace_ref="$(target_ref "$namespaced_target")"
namespace_snapshot="$(target_snapshot "$namespaced_target")"
require_value namespace_noise toggle-status
"$bin" find --app "$app" --role button --name reset-delayed-button --first >/dev/null 2>&1
namespace_get="$(get_target "$namespaced_target" --property role 2>/dev/null)"
namespace_ok="$(json_field "$namespace_get" ok)"
namespace_role="$(json_field "$namespace_get" data.value)"
assert "find ref re-resolves only through its returned snapshot_id" \
    "$([ "$namespace_ok" = "True" ] && [ "$namespace_role" = "button" ] && echo 1 || echo 0)" \
    "ref=$namespace_ref snapshot=$namespace_snapshot later_status=$namespace_noise role=$namespace_role"

note "Strict resolution never silently chooses the wrong twin"
require_target twin_target button twin-control
require_value twin_before twin-status
twin_output="$(act_target "$twin_target" click 2>/dev/null)"
sleep 0.35
require_value twin_after twin-status
twin_ok="$(json_field "$twin_output" ok)"
twin_code="$(json_field "$twin_output" error.code)"
if [ "$twin_ok" = "True" ]; then
    assert "addressed twin fired, never its sibling" "$([ "$twin_after" = "twin-a" ] && echo 1 || echo 0)" \
        "before=$twin_before after=$twin_after"
else
    assert "indistinguishable twins fail closed" "$([ "$twin_code" = "AMBIGUOUS_TARGET" ] && echo 1 || echo 0)" \
        "before=$twin_before after=$twin_after error=$twin_code"
fi
