note "Trace JSONL and secret redaction"
trace_file="$(mktemp -t agentdesk-e2e-trace.XXXXXX)"
cleanup_files+=("$trace_file")
require_target trace_text textfield text-input
trace_type="$("$bin" --headed --trace "$trace_file" type "$(target_ref "$trace_text")" \
    "sup3r-secret-trace" 2>/dev/null)"
sleep 0.2
require_value trace_echo text-echo
assert "headed trace typing reaches the target field" \
    "$([[ "$trace_echo" == *sup3r-secret-trace* ]] && echo 1 || echo 0)" \
    "observed_chars=${#trace_echo}"
trace_bytes="$(wc -c < "$trace_file" | tr -d ' ')"
trace_resolver="$(grep -q 'ref.resolve' "$trace_file" && echo 1 || echo 0)"
trace_leak="$(grep -q 'sup3r-secret-trace' "$trace_file" && echo 1 || echo 0)"
trace_redacted="$(grep -q 'redacted' "$trace_file" && echo 1 || echo 0)"
assert "trace records resolver events" \
    "$([ "$(json_field "$trace_type" ok)" = "True" ] && [ "$trace_resolver" = "1" ] && echo 1 || echo 0)" \
    "bytes=$trace_bytes resolver_events=$trace_resolver"
assert "typed secret never appears in trace" \
    "$([ "$trace_leak" = "0" ] && [ "$trace_redacted" = "1" ] && echo 1 || echo 0)" \
    "secret_present=$trace_leak redaction_marker=$trace_redacted"

note "Trace show and self-contained export"
trace_start="$("$bin" session start --screenshots --name e2e-trace 2>/dev/null)"
trace_session="$(json_field "$trace_start" data.session_id)"
if [ -z "$trace_session" ]; then
    abort_suite "trace session did not return a session_id"
fi
"$bin" --session "$trace_session" snapshot --app "$app" -i >/dev/null 2>&1
trace_target() {
    local role="$1" name="$2" output
    output="$("$bin" --session "$trace_session" find --app "$app" \
        --role "$role" --name "$name" --first 2>/dev/null)"
    printf '%s' "$output" | python3 "$json_tool" target 2>/dev/null
}
trace_primary="$(trace_target button primary-button)"
trace_text="$(trace_target textfield text-input)"
if [ -z "$trace_primary" ] || [ -z "$trace_text" ]; then
    abort_suite "trace session targets are missing"
fi
trace_click="$("$bin" --session "$trace_session" click "$(target_ref "$trace_primary")" 2>/dev/null)"
trace_session_type="$("$bin" --headed --session "$trace_session" type "$(target_ref "$trace_text")" \
    trace-e2e 2>/dev/null)"
sleep 0.5
trace_show="$("$bin" --session "$trace_session" trace show --limit 0 2>/dev/null)"
trace_events="$(printf '%s' "$trace_show" | python3 -c '
import json,sys
data=json.load(sys.stdin)
events=[entry.get("event") for entry in data.get("data",{}).get("events",[])]
required={"command.start","command.end","snapshot.saved","action.artifacts"}
print(1 if required.issubset(events) else 0)
' 2>/dev/null)"
trace_artifact_skips="$(printf '%s' "$trace_show" | python3 -c '
import json,sys
data=json.load(sys.stdin)
keys=("skipped","skipped_pre","skipped_post")
items=[]
for event in data.get("data",{}).get("events",[]):
    if event.get("event") == "action.artifacts":
        items.extend(f"{key}={event[key]}" for key in keys if key in event)
print(",".join(items) or "none")
' 2>/dev/null)"
trace_dir="${HOME}/.agent-desktop/sessions/${trace_session}/trace"
png_magic=0
if [ -d "$trace_dir/screens" ]; then
    first_png="$(find "$trace_dir/screens" -name '*.png' -print -quit 2>/dev/null)"
    if [ -n "$first_png" ] && [ "$(head -c 8 "$first_png" | xxd -p)" = "89504e470d0a1a0a" ]; then
        png_magic=1
    fi
fi
assert "trace show includes command and snapshot events" "$trace_events" \
    "session=$trace_session"
trace_artifacts_ok="$([ "$(json_field "$trace_click" ok)" = "True" ] && \
    [ "$(json_field "$trace_session_type" ok)" = "True" ] && [ "$png_magic" = "1" ] && echo 1 || echo 0)"
assert "trace screenshot artifacts have PNG magic" "$trace_artifacts_ok" \
    "click_ok=$(json_field "$trace_click" ok) type_ok=$(json_field "$trace_session_type" ok) directory=$trace_dir/screens exists=$([ -d "$trace_dir/screens" ] && echo yes || echo no) pngs=$(find "$trace_dir/screens" -name '*.png' 2>/dev/null | wc -l | tr -d ' ') skips=$trace_artifact_skips"

trace_html="$(mktemp -t agentdesk-e2e-trace-export.XXXXXX.html)"
cleanup_files+=("$trace_html")
"$bin" --session "$trace_session" trace export --out "$trace_html" --limit 0 >/dev/null 2>&1
html_ok=0
if [ -f "$trace_html" ] && ! grep -q 'src="http' "$trace_html" && grep -q 'application/json' "$trace_html"; then
    html_ok=1
fi
assert "trace export is self-contained HTML" "$html_ok" "path=$trace_html"
"$bin" session end "$trace_session" >/dev/null 2>&1

note "Release CLI operation timings"
performance_file="$(mktemp -t agentdesk-perf.XXXXXX)"
cleanup_files+=("$performance_file")
record_timing() {
    local label="$1"
    shift
    run_timed "$@"
    printf '%s\t%s\n' "$label" "$RUN_MS" >> "$performance_file"
    assert "timed operation succeeds: $label" \
        "$([ "$RUN_EXIT" -eq 0 ] && [ "$(json_field "$RUN_JSON" ok)" = "True" ] && echo 1 || echo 0)" \
        "exit=$RUN_EXIT elapsed_ms=$RUN_MS error=$(json_field "$RUN_JSON" error.code)"
}

"$bin" focus-window --app "$app" >/dev/null 2>&1
require_target perf_primary button primary-button
require_target perf_text textfield text-input
record_timing "snapshot full depth 30" "$bin" snapshot --app "$app" --max-depth 30
record_timing "snapshot skeleton" "$bin" snapshot --app "$app" --skeleton
record_timing "find role and name" "$bin" find --app "$app" --role button --name primary-button --first
record_timing "get exact ref" "$bin" get "$(target_ref "$perf_primary")" \
    --property role
record_timing "click AX press" "$bin" click "$(target_ref "$perf_primary")"
record_timing "set text value" "$bin" set-value "$(target_ref "$perf_text")" \
    perf-probe
record_timing "type text" "$bin" --headed type "$(target_ref "$perf_text")" \
    perf

awk -F'\t' '{printf "  %-26s %9.1f ms\n",$1,$2; n++; s+=$2}
    END{if(n) printf "  %-26s %9.1f ms (mean of %d ops)\n","[mean]",s/n,n}' "$performance_file"
full_snapshot_ms="$(awk -F'\t' '/snapshot full/{print $2; exit}' "$performance_file")"
assert "full fixture snapshot stays below the 2 second target" \
    "$(elapsed_in_range "${full_snapshot_ms:-99999}" 0 2000)" \
    "elapsed_ms=$full_snapshot_ms"

note "Force-close lifecycle observation"
running_before="$(running)"
"$bin" close-app "$app" --force >/dev/null 2>&1
sleep 1.5
running_after="$(running)"
if [ "$running_after" = "False" ]; then
    fixture_owned=0
    fixture_started=0
fi
assert "force close removes the fixture process" \
    "$([ "$running_before" = "True" ] && [ "$running_after" = "False" ] && echo 1 || echo 0)" \
    "before=$running_before after=$running_after"
