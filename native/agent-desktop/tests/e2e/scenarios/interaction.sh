interaction_suite() {
    local mode="$1" selection slider stepper direction natural_mechanism
    MODE_FLAG=""
    if [ "$mode" = "headed" ]; then
        MODE_FLAG="--headed"
        selection="Gamma"
        slider="60"
        stepper="6"
        direction="up"
        natural_mechanism="physical_synthetic"
        "$bin" focus-window --app "$app" >/dev/null 2>&1
    else
        selection="Beta"
        slider="50"
        stepper="4"
        direction="down"
        natural_mechanism="semantic_api"
    fi

    note "[$mode] exact-once click and text actions"
    local primary text_field click_before click_after before_number after_number click_output click_ok click_mechanism
    require_target primary button primary-button
    require_value click_before click-status
    click_output="$(act_target "$primary" click 2>/dev/null)"
    sleep 0.35
    require_value click_after click-status
    before_number="${click_before##*-}"
    after_number="${click_after##*-}"
    case "$before_number" in *[!0-9]*|'') before_number=0 ;; esac
    case "$after_number" in *[!0-9]*|'') after_number=0 ;; esac
    click_ok="$(json_field "$click_output" ok)"
    click_mechanism="$(printf '%s' "$click_output" | python3 "$json_tool" delivered-mechanism 2>/dev/null)"
    assert "[$mode] click dispatches exactly once" \
        "$([ "$click_ok" = "True" ] && [ "$after_number" -eq $((before_number + 1)) ] && [ "$click_mechanism" = "$natural_mechanism" ] && echo 1 || echo 0)" \
        "before=$click_before after=$click_after ok=$click_ok mechanism=$click_mechanism"

    require_target text_field textfield text-input
    act_target "$text_field" clear >/dev/null 2>&1
    sleep 0.2
    require_target text_field textfield text-input
    verify "[$mode] type sets field" text-echo "typed-$mode" "$natural_mechanism" "$text_field" type "typed-$mode"
    require_target text_field textfield text-input
    verify "[$mode] set-value sets field" text-echo "set-$mode" semantic_api "$text_field" set-value "set-$mode"
    require_target text_field textfield text-input
    verify "[$mode] clear empties field" text-echo "" "$natural_mechanism" "$text_field" clear

    note "[$mode] state and value controls"
    local toggle picker native_slider native_stepper scroll_area scroll_before scroll_after scroll_output scroll_mechanism scroll_ready
    require_target toggle checkbox toggle-box
    act_target "$toggle" uncheck >/dev/null 2>&1
    sleep 0.2
    require_target toggle checkbox toggle-box
    verify "[$mode] check turns toggle on" toggle-status on semantic_api "$toggle" check
    require_target toggle checkbox toggle-box
    verify "[$mode] uncheck turns toggle off" toggle-status off semantic_api "$toggle" uncheck

    require_target_by_id picker combobox option-picker
    verify "[$mode] select combobox" picker-status "$selection" semantic_api "$picker" select "$selection"
    require_target native_slider slider value-slider
    verify "[$mode] set slider value" slider-status "$slider" semantic_api "$native_slider" set-value "$slider"
    require_target native_stepper incrementor value-stepper
    verify "[$mode] set stepper value" stepper-status "$stepper" semantic_api "$native_stepper" set-value "$stepper"

    require_target scroll_area scrollarea scroll-area
    scroll_ready="$(act_target "$scroll_area" scroll-to 2>/dev/null)"
    assert "[$mode] scroll viewport is brought into view" \
        "$([ "$(json_field "$scroll_ready" ok)" = "True" ] && echo 1 || echo 0)" \
        "$(json_field "$scroll_ready" error.message)"
    require_value scroll_before scroll-offset
    scroll_output="$(act_target "$scroll_area" scroll --direction "$direction" --amount 10 2>/dev/null)"
    sleep 0.4
    require_value scroll_after scroll-offset
    scroll_mechanism="$(printf '%s' "$scroll_output" | python3 "$json_tool" delivered-mechanism 2>/dev/null)"
    assert "[$mode] scroll moves content" \
        "$([ "$scroll_before" != "$scroll_after" ] && [ "$scroll_mechanism" = "$natural_mechanism" ] && echo 1 || echo 0)" \
        "before=$scroll_before after=$scroll_after direction=$direction cmd_ok=$(json_field "$scroll_output" ok) cmd_err=$(json_field "$scroll_output" error.code) mechanism=$scroll_mechanism error=$(json_field "$scroll_output" error.message)"
}

interaction_suite headless
interaction_suite headed
MODE_FLAG=""

note "Radio and tab selection"
require_target radio_two radiobutton Two
verify "click radio option Two" radio-status Two semantic_api "$radio_two" click
require_target tab_two radiobutton "Tab Two"
verify "select Tab Two" tab-status 1 semantic_api "$tab_two" click
require_target tab_one radiobutton "Tab One"
verify "select Tab One" tab-status 0 semantic_api "$tab_one" click

note "Headed gesture fallback"
require_target double_target button double-target
"$bin" focus-window --app "$app" >/dev/null 2>&1
require_value double_before double-status
double_headless="$(act_target "$double_target" double-click 2>/dev/null)"
sleep 0.3
require_value double_after_headless double-status
double_code="$(json_field "$double_headless" error.code)"
assert "headless double-click fails closed without moving the cursor" \
    "$([ "$double_after_headless" = "$double_before" ] && [ "$double_code" = "POLICY_DENIED" ] && echo 1 || echo 0)" \
    "before=$double_before after=$double_after_headless error=$double_code"

"$bin" focus-window --app "$app" >/dev/null 2>&1
MODE_FLAG="--headed"
double_headed="$(act_target "$double_target" double-click 2>/dev/null)"
MODE_FLAG=""
sleep 0.35
require_value double_after_headed double-status
assert "headed double-click delivers the physical gesture" \
    "$([ "$double_after_headed" = "double-clicked" ] && echo 1 || echo 0)" \
    "before=$double_after_headless after=$double_after_headed ok=$(json_field "$double_headed" ok)"

require_target triple_target button triple-target
require_value triple_before triple-status
MODE_FLAG="--headed"
act_target "$triple_target" triple-click >/dev/null 2>&1
MODE_FLAG=""
sleep 0.4
require_value triple_after triple-status
assert "headed triple-click delivers a three-tap gesture" \
    "$([ "$triple_after" = "triple-clicked" ] && echo 1 || echo 0)" \
    "before=$triple_before after=$triple_after"

hover_preposition="$("$bin" --headed mouse-move --xy 20,20 2>/dev/null)"
"$bin" focus-window --app "$app" >/dev/null 2>&1
sleep 0.2
assert "hover precondition positions the pointer outside the target" \
    "$([ "$(json_field "$hover_preposition" ok)" = "True" ] && echo 1 || echo 0)" \
    "ok=$(json_field "$hover_preposition" ok) error=$(json_field "$hover_preposition" error.code)"
require_value hover_before hover-status
assert "hover baseline is clean after moving outside the target" \
    "$([ "$hover_before" != "hovered" ] && echo 1 || echo 0)" "status=$hover_before"
require_target hover_target button hover-target
MODE_FLAG="--headed"
hover_output="$(act_target "$hover_target" hover 2>/dev/null)"
MODE_FLAG=""
sleep 0.6
require_value hover_after hover-status
assert "headed hover triggers the fixture onHover" "$([ "$hover_after" = "hovered" ] && echo 1 || echo 0)" \
    "ref=$(target_ref "$hover_target") snapshot=$(target_snapshot "$hover_target") before=$hover_before after=$hover_after ok=$(json_field "$hover_output" ok) error=$(json_field "$hover_output" error.code)"
