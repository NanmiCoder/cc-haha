use super::*;
use crate::notifications::fake::element;
use agent_desktop_core::NotificationInfo;

fn entry(index: usize, app: &str, title: &str, object: &str) -> Entry {
    Entry {
        info: NotificationInfo {
            index,
            app_name: app.to_owned(),
            title: title.to_owned(),
            body: None,
            actions: Vec::new(),
        },
        node: element(object),
        header: Vec::new(),
        actions: Vec::new(),
    }
}

#[test]
fn bystanders_are_found_by_object_and_never_by_words() {
    let target = entry(1, "M", "a", "/one");
    let before = [
        target.clone(),
        entry(2, "M", "a", "/two"),
        entry(3, "C", "b", "/three"),
    ];
    let after = [entry(1, "M", "a", "/two")];
    let gone = bystanders(&before, &after, &target);
    assert_eq!(gone.len(), 1);
    assert_eq!(gone[0].node.path(), "/three");
}

#[test]
fn an_object_is_held_by_its_path_and_not_by_its_words() {
    let list = [entry(1, "M", "a", "/two")];
    assert!(holds(&list, &element("/two")));
    assert!(!holds(&list, &element("/one")));
}

#[test]
fn an_action_needs_the_entry_to_have_left_to_count() {
    assert_eq!(evidence(&[Signal::ActionInvoked(7)], false), None);
    assert_eq!(evidence(&[], false), None);
}

#[test]
fn a_closed_signal_alone_is_not_action_evidence() {
    assert_eq!(evidence(&[Signal::Closed(4)], true), Some("entry_removed"));
}

#[test]
fn one_action_signal_with_the_entry_gone_names_the_action() {
    assert_eq!(
        evidence(&[Signal::ActionInvoked(7)], true),
        Some("action_invoked")
    );
    assert_eq!(
        evidence(&[Signal::ActionInvoked(7), Signal::ActionInvoked(9)], true),
        Some("entry_removed")
    );
}
