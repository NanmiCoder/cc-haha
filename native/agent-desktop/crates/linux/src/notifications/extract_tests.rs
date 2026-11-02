use super::*;
use crate::notifications::fake::{reading, spec};

fn first_entry(specs: &[crate::notifications::fake::Spec]) -> Entry {
    let walked = reading(specs);
    extract(&walked, roots(&walked)[0], 1).expect("an entry")
}

#[test]
fn open_and_closed_shapes_give_the_same_fields() {
    let closed = first_entry(&[spec("Mail", "Hello").body("World")]);
    let open = first_entry(&[spec("Mail", "Hello").body("World").time("5 minutes ago")]);
    assert_eq!(closed.info.app_name, open.info.app_name);
    assert_eq!(closed.info.title, open.info.title);
    assert_eq!(closed.info.body, open.info.body);
    assert_eq!(open.info.title, "Hello");
}

#[test]
fn an_empty_body_is_none_and_a_long_body_is_whole() {
    assert_eq!(first_entry(&[spec("Mail", "Hi")]).info.body, None);
    let long: &'static str = Box::leak("x".repeat(700).into_boxed_str());
    let entry = first_entry(&[spec("Mail", "Hi").body(long)]);
    assert_eq!(entry.info.body.as_deref().map(str::len), Some(700));
}

#[test]
fn rtl_and_emoji_text_survive() {
    let entry = first_entry(&[spec("البريد", "مرحبا 🎉").body("שלום")]);
    assert_eq!(entry.info.app_name, "البريد");
    assert_eq!(entry.info.title, "مرحبا 🎉");
    assert_eq!(entry.info.body.as_deref(), Some("שלום"));
}

#[test]
fn actions_are_the_named_buttons_and_their_labels_do_not_leak_into_the_text() {
    let entry = first_entry(&[spec("Mail", "Hi").body("b").actions(&["Run A", "Run B"])]);
    assert_eq!(entry.info.actions, vec!["Run A", "Run B"]);
    assert_eq!(entry.info.body.as_deref(), Some("b"));
}

#[test]
fn a_two_label_entry_keeps_a_time_shaped_title() {
    let entry = first_entry(&[spec("Clock", "Just now")]);
    assert_eq!(entry.info.title, "Just now");
}

#[test]
fn an_entry_with_no_title_is_none() {
    let walked = reading(&[spec("Mail", "")]);
    assert!(extract(&walked, roots(&walked)[0], 1).is_none());
}

#[test]
fn the_age_label_is_dropped_by_its_place_in_the_header_in_any_language() {
    for time in ["5 minutes ago", "5分前", "منذ 5 دقائق", "vor 5 Minuten"] {
        let entry = first_entry(&[spec("Mail", "Hi").body("b").time(time)]);
        assert_eq!(entry.info.app_name, "Mail", "{time}");
        assert_eq!(entry.info.title, "Hi", "{time}");
        assert_eq!(entry.info.body.as_deref(), Some("b"), "{time}");
    }
}

#[test]
fn the_header_is_found_by_its_buttons_and_close_is_tried_last_button_first() {
    let entry = first_entry(&[spec("Mail", "Hi")]);
    let order: Vec<&str> = entry
        .close_candidates()
        .map(|control| control.element.path())
        .collect();
    assert_eq!(order, vec!["/Mail:Hi/close", "/Mail:Hi/expand"]);
    assert_eq!(
        entry.expand().expect("expand").element.path(),
        "/Mail:Hi/expand"
    );
    assert_eq!(entry.node.path(), "/Mail:Hi");
}

#[test]
fn a_header_with_one_button_proves_no_expand_control() {
    let entry = first_entry(&[spec("Mail", "Hi").header_buttons(1)]);
    assert!(entry.expand().is_none());
    assert_eq!(entry.close_candidates().count(), 1);
}

#[test]
fn an_entry_with_no_header_buttons_has_no_provable_fields() {
    let walked = reading(&[spec("Mail", "Hi").header_buttons(0)]);
    assert!(extract(&walked, roots(&walked)[0], 1).is_none());
}

#[test]
fn notification_nodes_nested_in_another_are_not_entries_of_their_own() {
    let mut walked = reading(&[spec("Mail", "a"), spec("Chat", "b")]);
    let siblings = roots(&walked);
    assert_eq!(siblings.len(), 2);
    let (outer, inner) = (siblings[0], siblings[1]);
    let old_parent = walked.visits[inner].parent.expect("a parent");
    walked.visits[old_parent]
        .children
        .retain(|child| *child != inner);
    walked.visits[inner].parent = Some(outer);
    walked.visits[outer].children.push(inner);
    assert_eq!(roots(&walked), vec![outer]);
}
