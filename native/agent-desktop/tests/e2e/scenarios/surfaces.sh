note "Sheet surface discovery and interaction"
"$bin" focus-window --app "$app" >/dev/null 2>&1
require_value sheet_before sheet-status
require_target open_sheet button open-sheet
act_target "$open_sheet" scroll-to >/dev/null 2>&1
require_target open_sheet button open-sheet
act_target "$open_sheet" click >/dev/null 2>&1
sleep 0.6
surface_list="$("$bin" list-surfaces --app "$app" 2>/dev/null)"
surface_has_sheet="$(printf '%s' "$surface_list" | grep -q '"type":"sheet"' && echo 1 || echo 0)"
assert "list-surfaces reports the opened sheet" "$surface_has_sheet" \
    "surfaces=$(json_field "$surface_list" data.surfaces)"
require_target confirm_sheet button confirm-sheet
act_target "$confirm_sheet" click >/dev/null 2>&1
sleep 0.5
require_value sheet_after sheet-status
assert "a ref found inside the sheet performs its action" \
    "$([ "$sheet_after" = "confirmed" ] && echo 1 || echo 0)" \
    "before=$sheet_before after=$sheet_after"

note "Context menu discovery and action"
"$bin" focus-window --app "$app" >/dev/null 2>&1
require_value context_before right-status
require_target context_target button context-target
act_target "$context_target" scroll-to >/dev/null 2>&1
require_target context_target button context-target
context_output="$(act_target "$context_target" right-click 2>/dev/null)"
sleep 0.5
require_target context_choice menuitem context-choice
act_target "$context_choice" click >/dev/null 2>&1
sleep 0.4
require_value context_after right-status
context_ok="$(json_field "$context_output" ok)"
context_code="$(json_field "$context_output" error.code)"
context_operation="$(json_field "$context_output" error.details.operation)"
context_delivery="$(json_field "$context_output" error.disposition.delivery)"
context_retry="$(json_field "$context_output" error.disposition.retry)"
assert "right-click reports success or exact macOS modal delivery uncertainty" \
    "$([ "$context_ok" = "True" ] || \
        { [ "$context_code" = "APP_UNRESPONSIVE" ] && [ "$context_operation" = "AXShowMenu" ] && \
          [ "$context_delivery" = "delivery_uncertain" ] && [ "$context_retry" = "unsafe" ]; } && echo 1 || echo 0)" \
    "ok=$context_ok code=$context_code operation=$context_operation delivery=$context_delivery retry=$context_retry"
assert "context-menu item action is independently observed" \
    "$([ "$context_after" = "context-picked" ] && echo 1 || echo 0)" \
    "before=$context_before after=$context_after"

note "Menu bar enumeration"
"$bin" focus-window --app "$app" >/dev/null 2>&1
sleep 0.2
menu_snapshot="$("$bin" snapshot --app "$app" --surface menubar --max-depth 5 2>/dev/null)"
menu_items="$(printf '%s' "$menu_snapshot" | grep -o '"role":"menuitem"' | wc -l | tr -d ' ')"
has_fixture_menu="$(printf '%s' "$menu_snapshot" | grep -q '"name":"Fixture"' && echo 1 || echo 0)"
assert "menu bar exposes the custom Fixture menu" \
    "$([ "$has_fixture_menu" = "1" ] && [ "$menu_items" -gt 0 ] && echo 1 || echo 0)" \
    "menuitems=$menu_items fixture_menu=$has_fixture_menu"

note "Source-tracked drag gesture"
require_value drag_before drag-canvas-status
drag_anchor="$(find_target_by_id group drag-canvas || find_target group drag-canvas || true)"
if [ -n "$drag_anchor" ]; then
    act_target "$drag_anchor" scroll-to >/dev/null 2>&1
    sleep 0.3
fi
drag_focus="$("$bin" focus-window --app "$app" 2>/dev/null)"
if [ "$(json_field "$drag_focus" ok)" != "True" ]; then
    abort_suite "drag fixture focus failed: $(json_field "$drag_focus" error.code)"
fi
drag_snapshot="$("$bin" snapshot --app "$app" --include-bounds --max-depth 30 2>/dev/null)"
drag_points="$(printf '%s' "$drag_snapshot" | python3 "$json_tool" tree drag-canvas drag 2>/dev/null)" || drag_points=""
if [ -z "$drag_points" ]; then
    abort_suite "required drag-canvas bounds are missing"
fi
drag_from="${drag_points%% *}"
drag_to="${drag_points#* }"
drag_output="$("$bin" --headed drag --from-xy "$drag_from" --to-xy "$drag_to" \
    --duration 400 --drop-delay 300 2>/dev/null)"
sleep 0.4
require_value drag_after drag-canvas-status
drag_effect="$(printf '%s' "$drag_after" | grep -q '^dragged-' && echo 1 || echo 0)"
assert "headed drag delivers one source-tracked gesture" \
    "$([ "$(json_field "$drag_output" ok)" = "True" ] && [ "$drag_effect" = "1" ] && echo 1 || echo 0)" \
    "from=$drag_from to=$drag_to before=$drag_before after=$drag_after"

note "Disclosure collapse and expand"
# SwiftUI DisclosureGroup does not expose expanded-state via AXValue; the honest
# oracle is whether the disclosed child content appears/disappears in the tree.
disclosed_present() {
    local out
    out="$("$bin" find --app "$app" --role statictext --name disclosed-content --first 2>/dev/null)"
    if [ "$(json_field "$out" ok)" = "True" ] && [ -n "$(json_field "$out" data.match)" ]; then
        echo 1
        return
    fi
    out="$("$bin" find --app "$app" --role statictext --name disclosure-section --first 2>/dev/null)"
    [ "$(json_field "$out" ok)" = "True" ] && [ -n "$(json_field "$out" data.match)" ] && echo 1 || echo 0
}
require_target disclosure disclosure disclosure-section
initially_hidden="$(disclosed_present)"
assert "disclosure starts with its child hidden" "$([ "$initially_hidden" = "0" ] && echo 1 || echo 0)" \
    "content_present=$initially_hidden"
MODE_FLAG="--headed"
first_expand_output="$(act_target "$disclosure" expand 2>/dev/null)"
MODE_FLAG=""
sleep 0.4
expanded_before="$(disclosed_present)"
assert "expand reveals the initially hidden disclosure content" \
    "$([ "$(json_field "$first_expand_output" ok)" = "True" ] && [ "$expanded_before" = "1" ] && echo 1 || echo 0)" \
    "content_present=$expanded_before error=$(json_field "$first_expand_output" error.code)"
require_target disclosure disclosure disclosure-section
MODE_FLAG="--headed"
collapse_output="$(act_target "$disclosure" collapse 2>/dev/null)"
MODE_FLAG=""
sleep 0.4
collapsed_hidden="$(disclosed_present)"
require_target disclosure disclosure disclosure-section
MODE_FLAG="--headed"
expand_output="$(act_target "$disclosure" expand 2>/dev/null)"
MODE_FLAG=""
sleep 0.4
expanded_shown="$(disclosed_present)"
assert "collapse hides the disclosed content" \
    "$([ "$(json_field "$collapse_output" ok)" = "True" ] && [ "$collapsed_hidden" = "0" ] && echo 1 || echo 0)" \
    "content_present=$collapsed_hidden error=$(json_field "$collapse_output" error.code)"
assert "expand reveals the disclosed content" \
    "$([ "$(json_field "$expand_output" ok)" = "True" ] && [ "$expanded_shown" = "1" ] && echo 1 || echo 0)" \
    "content_present=$expanded_shown error=$(json_field "$expand_output" error.code)"
