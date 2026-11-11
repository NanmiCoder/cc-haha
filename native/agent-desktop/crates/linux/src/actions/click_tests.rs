use std::cell::Cell;

use agent_desktop_core::{Action, Deadline, DeliverySemantics, ErrorCode};

use super::*;
use crate::adapter::LinuxAdapter;
use crate::tree::atspi_element;
use crate::tree::vocabulary::role_numbers::PUSH_BUTTON;

#[test]
fn a_delivered_write_is_judged_by_the_observed_change() {
    let outcome = deliver(Ok(WriteReply::Done), || Some(false)).expect("delivered");
    assert_eq!(outcome, DeliveryOutcome::Delivered(Observed::Unchanged));
}

#[test]
fn an_absent_verb_reply_is_not_delivered_and_reads_nothing() {
    let reads = Cell::new(0);
    let outcome = deliver(Ok(WriteReply::Absent), || {
        reads.set(reads.get() + 1);
        Some(true)
    })
    .expect("answered");
    assert_eq!(outcome, DeliveryOutcome::NotDelivered);
    assert_eq!(reads.get(), 0);
}

#[test]
fn a_refused_write_is_passed_through_and_reads_nothing() {
    let reads = Cell::new(0);
    let refused = AdapterError::new(ErrorCode::InvalidArgs, "bad");
    let error = deliver(Err(refused), || {
        reads.set(reads.get() + 1);
        Some(true)
    })
    .expect_err("refused");
    assert_eq!(error.code, ErrorCode::InvalidArgs);
    assert_eq!(reads.get(), 0);
}

#[test]
fn only_a_toggle_child_with_a_verb_is_the_menu_button_inner() {
    assert!(is_inner_toggle(Some(TOGGLE_BUTTON), true));
    assert!(!is_inner_toggle(Some(TOGGLE_BUTTON), false));
    assert!(!is_inner_toggle(Some(PUSH_BUTTON), true));
    assert!(!is_inner_toggle(None, true));
}

#[test]
fn a_missing_verb_is_not_supported_and_not_delivered() {
    let error = no_semantic_verb(&Action::Click);
    assert_eq!(error.code, ErrorCode::ActionNotSupported);
    assert_eq!(error.disposition, DeliverySemantics::not_delivered());
    assert_eq!(
        error.details.expect("details")["semantic_verb"],
        serde_json::json!("absent")
    );
}

#[test]
fn a_node_with_no_action_names_writes_nothing() {
    let adapter = LinuxAdapter::new();
    let handle = AtspiElement::new(":1.1", "/a", 1).into_native_handle();
    let target = Target {
        bus: adapter.bus(),
        handle: &handle,
        element: atspi_element(&handle).expect("element"),
        deadline: Deadline::standard().expect("deadline"),
    };
    let error =
        invoke_verb(&target, &Action::RightClick, &[], &["showContextMenu"]).expect_err("refused");
    assert_eq!(error.code, ErrorCode::ActionNotSupported);
    assert_eq!(error.disposition, DeliverySemantics::not_delivered());
}

fn names(list: &[&str]) -> Vec<String> {
    list.iter().map(|name| (*name).to_owned()).collect()
}

#[test]
fn a_chromium_checkbox_advertising_check_clicks_through_check() {
    let verbs = verbs_for(&Action::Click);
    let chosen = names(&["check", "showContextMenu"]);
    assert_eq!(resolve_verb(&chosen, verbs), Some(0));
}

#[test]
fn a_node_with_a_plain_click_verb_never_uses_check() {
    let verbs = verbs_for(&Action::Click);
    let chosen = names(&["check", "click"]);
    assert_eq!(resolve_verb(&chosen, verbs), Some(1));
}

#[test]
fn do_default_and_context_menu_alone_are_no_click_verb() {
    let verbs = verbs_for(&Action::Click);
    let chosen = names(&["doDefault", "showContextMenu"]);
    assert_eq!(resolve_verb(&chosen, verbs), None);
}

#[test]
fn a_div_advertising_click_ancestor_is_clicked_through_it() {
    let verbs = verbs_for(&Action::Click);
    let chosen = names(&["clickAncestor"]);
    assert_eq!(resolve_verb(&chosen, verbs), Some(0));
}

#[test]
fn a_menu_item_with_only_show_menu_is_clicked_through_it() {
    use crate::tree::vocabulary::role_numbers::MENU_ITEM;
    let chosen = names(&["ShowMenu"]);
    assert_eq!(
        resolve_verb(&chosen, click_verbs(Some(MENU_ITEM))),
        Some(0),
        "a menu item's own open action is its click"
    );
    assert_eq!(resolve_verb(&chosen, click_verbs(Some(PUSH_BUTTON))), None);
    assert_eq!(resolve_verb(&chosen, click_verbs(None)), None);
}

#[test]
fn a_switch_with_only_a_toggle_verb_is_clicked_through_the_toggle() {
    use crate::tree::vocabulary::role_numbers::{CHECK_BOX, TOGGLE_BUTTON};
    let toggle_only = names(&["toggle"]);
    assert!(toggles_in_place(Some(CHECK_BOX), &toggle_only));
    assert!(toggles_in_place(Some(TOGGLE_BUTTON), &toggle_only));
    assert!(!toggles_in_place(Some(PUSH_BUTTON), &toggle_only));
    assert!(!toggles_in_place(None, &toggle_only));
    assert!(!toggles_in_place(Some(CHECK_BOX), &names(&["doDefault"])));
}
