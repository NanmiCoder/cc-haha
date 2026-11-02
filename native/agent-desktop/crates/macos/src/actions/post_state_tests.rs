use super::*;
use crate::tree::{
    properties::node_attr_states::NodeAttrStates, properties::node_attrs::NodeAttrs,
};

fn transient_observation_error() -> AdapterError {
    incomplete_live_evidence().with_details(serde_json::json!({
        "kind": "live_element_evidence",
        "retryable": true,
        "query_stats": { "reads": { "cannot_complete": 1 } }
    }))
}

#[test]
fn live_observation_recovers_transient_native_reads_without_mutation() {
    let mut reads = 0;
    let result = read_observation_with_recovery(Deadline::after(5_000).unwrap(), || {
        reads += 1;
        if reads < 3 {
            Err(transient_observation_error())
        } else {
            Ok("observed")
        }
    })
    .unwrap();
    assert_eq!(result, "observed");
    assert_eq!(reads, 3);
}

#[test]
fn live_observation_recovery_is_bounded_and_preserves_terminal_errors() {
    for (error, expected_reads) in [
        (transient_observation_error(), 3),
        (AdapterError::permission_denied(), 1),
        (AdapterError::stale_ref("replaced"), 1),
        (incomplete_live_evidence(), 1),
        (
            transient_observation_error().with_details(serde_json::json!({
                "kind": "live_element_evidence",
                "retryable": false,
                "query_stats": { "reads": { "cannot_complete": 1 } }
            })),
            1,
        ),
    ] {
        let mut reads = 0;
        let result = read_observation_with_recovery::<()>(Deadline::after(5_000).unwrap(), || {
            reads += 1;
            Err(error.clone())
        })
        .unwrap_err();
        assert_eq!(reads, expected_reads);
        assert_eq!(result.code, error.code);
        assert_eq!(result.details, error.details);
    }
}

#[test]
fn expired_live_observation_budget_never_calls_native_reader() {
    let deadline = Deadline::after(0).unwrap();
    let result = read_observation_with_recovery::<()>(deadline, || panic!("expired read"));
    assert_eq!(result.unwrap_err().code, ErrorCode::Timeout);
}

fn attrs_with_bounds(bounds: Rect) -> NodeAttrs {
    NodeAttrs {
        role: Some("AXButton".into()),
        subrole: None,
        value: None,
        name_evidence: agent_desktop_core::NameEvidence {
            native_title: Some("Target".into()),
            ..agent_desktop_core::NameEvidence::default()
        },
        states: NodeAttrStates::default(),
        bounds: Some(bounds),
        has_scrollbars: false,
    }
}

#[test]
fn element_state_from_attrs_includes_offscreen_when_window_bounds_supplied() {
    let el = crate::tree::AXElement(std::ptr::null_mut());
    let attrs = attrs_with_bounds(Rect {
        x: 1000.0,
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

    let state = element_state_from_attrs(&el, attrs, "button".into(), Some(window)).unwrap();

    assert!(
        state
            .states
            .contains(&agent_desktop_core::tree::state::OFFSCREEN.to_string())
    );
}

#[test]
fn element_state_from_attrs_omits_offscreen_without_window_bounds() {
    let el = crate::tree::AXElement(std::ptr::null_mut());
    let attrs = attrs_with_bounds(Rect {
        x: 1000.0,
        y: 0.0,
        width: 10.0,
        height: 10.0,
    });

    let state = element_state_from_attrs(&el, attrs, "button".into(), None).unwrap();

    assert!(
        !state
            .states
            .contains(&agent_desktop_core::tree::state::OFFSCREEN.to_string())
    );
}

#[test]
fn post_state_uses_the_same_subrole_mapping_as_snapshot_observation() {
    assert_eq!(
        normalized_role(Some("AXRow"), Some("AXOutlineRow")),
        "treeitem"
    );
}

#[test]
fn secure_subrole_never_exposes_its_value() {
    let el = crate::tree::AXElement(std::ptr::null_mut());
    let mut attrs = attrs_with_bounds(Rect {
        x: 0.0,
        y: 0.0,
        width: 10.0,
        height: 10.0,
    });
    attrs.role = Some("AXTextField".into());
    attrs.subrole = Some("AXSecureTextField".into());
    attrs.value = Some("secret".into());

    let state = element_state_from_attrs(&el, attrs, "textfield".into(), None).unwrap();

    assert_eq!(state.value, None);
}

#[test]
fn element_visibility_preserves_live_hidden_evidence_for_every_role() {
    for canonical in [LocatorField::Unknown, LocatorField::Absent] {
        assert_eq!(hidden_state(None, &canonical), None);
        assert_eq!(hidden_state(Some(false), &canonical), Some(false));
        assert_eq!(hidden_state(Some(true), &canonical), Some(true));
    }
}

#[test]
fn complete_visibility_evidence_does_not_require_an_expanded_attribute() {
    let el = crate::tree::AXElement(std::ptr::null_mut());
    let bounds = Rect {
        x: 0.0,
        y: 0.0,
        width: 28.0,
        height: 28.0,
    };
    for hidden in [false, true] {
        let mut attrs = attrs_with_bounds(bounds);
        attrs.role = Some("AXMenuButton".into());
        let canonical = LocatorField::Known(if hidden {
            vec![agent_desktop_core::tree::state::HIDDEN.into()]
        } else {
            Vec::new()
        });
        attrs.states.semantic.hidden = hidden_state(None, &canonical);
        let state =
            element_state_from_attrs(&el, attrs, "menubutton".into(), Some(bounds)).unwrap();
        assert_eq!(state.hidden, Some(hidden));
        assert_eq!(state.offscreen, Some(false));
        assert!(!states_are_complete(&state, false));
    }
}

#[test]
fn optional_identity_gaps_do_not_poison_complete_actionability_evidence() {
    let mut evidence = agent_desktop_core::LocatorEvidence {
        role: LocatorField::Known("scrollarea".into()),
        name: LocatorField::Unknown,
        description: LocatorField::Unknown,
        value: LocatorField::Absent,
        identifiers: agent_desktop_core::IdentifierEvidence::unknown(),
        states: LocatorField::Known(Vec::new()),
        ref_evidence: agent_desktop_core::LocatorRefEvidence {
            window_bounds: LocatorField::Absent,
            bounds: LocatorField::Known(Rect {
                x: 0.0,
                y: 0.0,
                width: 100.0,
                height: 100.0,
            }),
            available_actions: LocatorField::Known(vec!["Scroll".into()]),
            descriptors: Default::default(),
        },
    };

    assert!(essential_live_evidence_complete(&evidence));
    evidence.states = LocatorField::Unknown;
    assert!(!essential_live_evidence_complete(&evidence));
}

#[test]
fn an_unread_expanded_attribute_is_not_complete_state_evidence() {
    let element = |role: &str| agent_desktop_core::ElementState {
        role: role.into(),
        states: Vec::new(),
        value: None,
        enabled: Some(true),
        hidden: Some(false),
        offscreen: Some(false),
    };

    assert!(!states_are_complete(&element("disclosure"), false));
    assert!(states_are_complete(&element("disclosure"), true));
    assert!(states_are_complete(&element("button"), false));
    assert!(!states_are_complete(&element("checkbox"), true));
}
