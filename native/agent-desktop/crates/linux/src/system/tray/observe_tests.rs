use agent_desktop_core::{
    ElementIdentifier, ElementState, IdentifierEvidence, IdentifierKind, LiveElement, LiveIdentity,
    LocatorField, Rect,
};

use super::evidence_of;

fn live(bounds: Option<Rect>) -> LiveElement {
    LiveElement {
        identity: LiveIdentity {
            name: LocatorField::Known("Dropbox".to_owned()),
            description: LocatorField::Absent,
            identifiers: IdentifierEvidence::typed(
                [ElementIdentifier {
                    kind: IdentifierKind::RuntimeId,
                    value: "tray:v1:item|:1.5|/StatusNotifierItem".to_owned(),
                }],
                Some(0),
                true,
            ),
        },
        state: ElementState {
            role: "menubutton".to_owned(),
            states: vec!["offscreen".to_owned()],
            value: None,
            enabled: Some(true),
            hidden: Some(false),
            offscreen: Some(true),
        },
        states_complete: true,
        bounds,
        available_actions: vec!["Click".to_owned()],
    }
}

#[test]
fn a_live_tray_node_becomes_complete_evidence_for_hydration() {
    let evidence = evidence_of(&live(None));
    assert_eq!(
        evidence.role.known().map(String::as_str),
        Some("menubutton")
    );
    assert!(!evidence.states.is_unknown());
    assert!(!evidence.ref_evidence.bounds.is_unknown());
    assert!(evidence.identifiers.is_complete());
}

#[test]
fn a_bound_node_carries_its_panel_rectangle_and_an_unbound_one_none() {
    let rect = Rect {
        x: 10.0,
        y: 0.0,
        width: 48.0,
        height: 32.0,
    };
    assert_eq!(
        evidence_of(&live(Some(rect))).ref_evidence.bounds.known(),
        Some(&rect)
    );
    assert_eq!(evidence_of(&live(None)).ref_evidence.bounds.known(), None);
}
