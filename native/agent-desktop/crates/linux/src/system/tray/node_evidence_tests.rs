use agent_desktop_core::tree::state;

use super::*;

#[test]
fn the_passive_state_is_the_hidden_token_and_replaces_nothing_else() {
    let states = item_states(true, vec!["showing".into()]);
    assert_eq!(states, ["showing", state::HIDDEN]);
}

#[test]
fn an_active_item_carries_no_hidden_token_even_if_the_node_had_one() {
    let states = item_states(false, vec![state::HIDDEN.into(), "showing".into()]);
    assert_eq!(states, ["showing"]);
}

#[test]
fn an_empty_name_is_absent_not_known_empty() {
    assert_eq!(name_field(""), LocatorField::Absent);
    assert_eq!(name_field("Open"), LocatorField::Known("Open".into()));
}
