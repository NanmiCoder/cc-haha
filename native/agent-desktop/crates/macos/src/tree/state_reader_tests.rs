use super::*;
use crate::tree::{
    properties::node_attr_states::NodeAttrStates, properties::node_attrs::NodeAttrs,
};
use agent_desktop_core::Rect;

fn sample_attrs() -> NodeAttrs {
    NodeAttrs {
        role: Some("AXCheckBox".into()),
        subrole: None,
        value: Some("2".into()),
        name_evidence: agent_desktop_core::NameEvidence::default(),
        states: NodeAttrStates::default(),
        bounds: Some(Rect {
            x: 0.0,
            y: 0.0,
            width: 10.0,
            height: 10.0,
        }),
        has_scrollbars: false,
    }
}

fn ctx_with(window_bounds: Option<Rect>, is_secure_text: bool) -> StateReaderContext<'static> {
    StateReaderContext {
        focused: None,
        window_bounds,
        is_secure_text,
    }
}

#[test]
fn mixed_checkbox_emits_indeterminate_not_checked() {
    let attrs = sample_attrs();
    let ctx = ctx_with(None, false);
    let el = AXElement(std::ptr::null_mut());
    let states = states_from_element(&el, &attrs, "checkbox", &ctx);
    assert!(states.contains(&state::INDETERMINATE.to_string()));
    assert!(!states.contains(&state::CHECKED.to_string()));
}

#[test]
fn checked_value_spellings_match_action_readback() {
    for value in ["1", "true", "yes", "on", "checked", " ON "] {
        let mut attrs = sample_attrs();
        attrs.value = Some(value.into());
        let el = AXElement(std::ptr::null_mut());
        let states = states_from_element(&el, &attrs, "checkbox", &ctx_with(None, false));
        assert!(states.contains(&state::CHECKED.to_string()), "{value}");
    }
}

#[test]
fn hidden_attr_emits_hidden_token() {
    let mut attrs = sample_attrs();
    attrs.states.semantic.hidden = Some(true);
    let ctx = ctx_with(None, false);
    let el = AXElement(std::ptr::null_mut());
    let states = states_from_element(&el, &attrs, "button", &ctx);
    assert!(states.contains(&state::HIDDEN.to_string()));
}

#[test]
fn clipped_bounds_emit_offscreen() {
    let mut attrs = sample_attrs();
    attrs.bounds = Some(Rect {
        x: 100.0,
        y: 0.0,
        width: 10.0,
        height: 10.0,
    });
    let window = Rect {
        x: 0.0,
        y: 0.0,
        width: 50.0,
        height: 50.0,
    };
    let ctx = ctx_with(Some(window), false);
    let el = AXElement(std::ptr::null_mut());
    let states = states_from_element(&el, &attrs, "button", &ctx);
    assert!(states.contains(&state::OFFSCREEN.to_string()));
}

#[test]
fn emitted_tokens_over_representative_inputs_are_vocabulary_members() {
    let el = AXElement(std::ptr::null_mut());
    let window = Rect {
        x: 0.0,
        y: 0.0,
        width: 50.0,
        height: 50.0,
    };
    let mut cases: Vec<(NodeAttrs, &str, StateReaderContext<'static>)> = Vec::new();

    let mut disabled = sample_attrs();
    disabled.states.enabled = false;
    cases.push((disabled, "button", ctx_with(None, false)));

    cases.push((sample_attrs(), "textfield", ctx_with(None, true)));

    let mut expanded = sample_attrs();
    expanded.states.control.expanded = Some(true);
    cases.push((expanded, "disclosure", ctx_with(None, false)));

    let mut checked = sample_attrs();
    checked.value = Some("1".into());
    cases.push((checked, "checkbox", ctx_with(None, false)));

    let mut selected = sample_attrs();
    selected.states.control.selected = Some(true);
    cases.push((selected, "cell", ctx_with(None, false)));

    let mut busy = sample_attrs();
    busy.states.semantic.busy = Some(true);
    cases.push((busy, "button", ctx_with(None, false)));

    let mut modal = sample_attrs();
    modal.states.semantic.modal = Some(true);
    cases.push((modal, "window", ctx_with(None, false)));

    let mut required = sample_attrs();
    required.states.semantic.required = Some(true);
    cases.push((required, "textfield", ctx_with(None, false)));

    let mut pressed = sample_attrs();
    pressed.value = Some("1".into());
    cases.push((pressed, "button", ctx_with(None, false)));

    let mut readonly = sample_attrs();
    readonly.states.control.readonly = Some(true);
    cases.push((readonly, "textfield", ctx_with(None, false)));

    let mut offscreen = sample_attrs();
    offscreen.bounds = Some(Rect {
        x: 1000.0,
        y: 0.0,
        width: 10.0,
        height: 10.0,
    });
    cases.push((offscreen, "button", ctx_with(Some(window), false)));

    let mut emitted: Vec<String> = Vec::new();
    for (attrs, role, ctx) in &cases {
        emitted.extend(states_from_element(&el, attrs, role, ctx));
    }
    assert!(
        !emitted.is_empty(),
        "representative inputs should exercise at least one producer branch"
    );
    state::assert_states_in_vocabulary(&emitted);
}

#[test]
#[should_panic(expected = "is not in STATE_VOCABULARY")]
fn assert_states_in_vocabulary_rejects_bogus_token() {
    state::assert_states_in_vocabulary(&["zzz_bogus_state_token".to_string()]);
}

#[test]
fn disclosure_value_is_role_scoped_and_explicit_state_wins() {
    use super::expanded_state;
    let role = Some("AXDisclosureTriangle");
    assert_eq!(expanded_state(role, None, Some("1")), Some(true));
    assert_eq!(expanded_state(role, None, Some("0")), Some(false));
    assert_eq!(expanded_state(role, Some(false), Some("1")), Some(false));
    for value in [None, Some("2"), Some("unknown")] {
        assert_eq!(expanded_state(role, None, value), None);
    }
    for role in [None, Some("AXButton"), Some("AXRow"), Some("AXTextField")] {
        assert_eq!(expanded_state(role, None, Some("1")), None);
    }
    let mut attrs = sample_attrs();
    attrs.role = Some("AXDisclosureTriangle".into());
    attrs.value = Some("1".into());
    assert_eq!(super::expanded_from_attrs(&attrs), Some(true));
}
