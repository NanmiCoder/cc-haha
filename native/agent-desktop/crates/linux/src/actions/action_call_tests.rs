use agent_desktop_core::{Deadline, NativeHandle};

use super::*;
use crate::actions::context::Target;
use crate::system::SharedBus;
use crate::tree::AtspiElement;

fn names(listed: &[&str]) -> Vec<String> {
    listed.iter().map(|name| (*name).to_owned()).collect()
}

#[test]
fn the_requested_verb_order_decides_between_two_matching_names() {
    let listed = names(&["activate", "click"]);
    assert_eq!(resolve_verb(&listed, &["click", "activate"]), Some(1));
    assert_eq!(resolve_verb(&listed, &["activate", "click"]), Some(0));
}

#[test]
fn a_blank_name_matches_nothing_and_the_next_index_still_resolves() {
    let listed = names(&["", "click"]);
    assert_eq!(resolve_verb(&listed, &["click"]), Some(1));
    assert_eq!(resolve_verb(&names(&[""]), &["click", ""]), None);
}

#[test]
fn an_empty_name_list_is_absent_and_sends_nothing() {
    let bus = SharedBus::default();
    let element = AtspiElement::new(":1.1", "/p", 1);
    let handle = NativeHandle::new(element.clone());
    let target = Target {
        bus: &bus,
        handle: &handle,
        element: &element,
        deadline: Deadline::after(1_000).expect("a deadline builds"),
    };
    assert_eq!(
        do_action(&target, &[], &["click"]).expect("no write is attempted"),
        WriteReply::Absent
    );
    assert_eq!(
        do_action(&target, &names(&["doDefault"]), &["click"]).expect("no write is attempted"),
        WriteReply::Absent
    );
}
