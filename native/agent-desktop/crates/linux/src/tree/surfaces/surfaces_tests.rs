use super::is_sheet;
use crate::tree::live::test_support::{read_of, words};
use crate::tree::{Field, RawNode};

const MODAL: u32 = 16;
const SHOWING: u32 = 25;

fn node(role: u32, state_bits: &[u32]) -> RawNode {
    let mut node = read_of(role, "d", &[]).node;
    node.traits.states = Field::Present(words(state_bits));
    node
}

#[test]
fn a_showing_dialog_is_a_sheet_modal_or_not() {
    assert!(is_sheet(&node(16, &[SHOWING, MODAL])));
    assert!(is_sheet(&node(16, &[SHOWING])));
    assert!(is_sheet(&node(19, &[SHOWING])));
    assert!(is_sheet(&node(2, &[SHOWING])));
}

#[test]
fn a_modal_top_level_is_a_sheet_whatever_its_role() {
    assert!(is_sheet(&node(23, &[SHOWING, MODAL])));
    assert!(is_sheet(&node(39, &[SHOWING, MODAL])));
    assert!(is_sheet(&node(16, &[MODAL])));
}

#[test]
fn a_plain_frame_and_a_hidden_modeless_dialog_are_not_sheets() {
    assert!(!is_sheet(&node(23, &[SHOWING])));
    assert!(!is_sheet(&node(16, &[])));
    assert!(!is_sheet(&node(69, &[SHOWING, 1])));
}

#[test]
fn an_unreadable_role_or_state_set_is_never_a_sheet() {
    let mut failed_role = node(16, &[SHOWING, MODAL]);
    failed_role.traits.role = Field::Failed("role".to_owned());
    assert!(!is_sheet(&failed_role));
    let mut failed_states = node(16, &[]);
    failed_states.traits.states = Field::Failed("states".to_owned());
    assert!(!is_sheet(&failed_states));
}

#[test]
fn alerts_require_showing_alert_evidence() {
    use agent_desktop_core::SnapshotSurface::Alert;
    for (role, states, expected) in [
        (2, vec![SHOWING], true),
        (2, vec![MODAL], false),
        (16, vec![SHOWING, MODAL], false),
        (23, vec![SHOWING], false),
    ] {
        assert_eq!(super::is_surface(&node(role, &states), Alert), expected);
    }
    let mut alert = node(2, &[SHOWING]);
    alert.traits.states = Field::Failed("states".into());
    assert!(!super::is_surface(&alert, Alert));
    alert = node(2, &[SHOWING]);
    alert.traits.role = Field::Failed("role".into());
    assert!(!super::is_surface(&alert, Alert));
}
