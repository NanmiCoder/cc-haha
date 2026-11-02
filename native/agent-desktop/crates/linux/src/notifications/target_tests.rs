use super::*;
use crate::notifications::fake::{FakeWorld, log, reading, spec};
use agent_desktop_core::{Deadline, ErrorCode};

fn deadline() -> Deadline {
    Deadline::after(1_000).expect("a deadline")
}

fn wanted<'a>(app_filter: Option<&'a str>, identity: &'a NotificationIdentity) -> Wanted<'a> {
    Wanted {
        index: 1,
        app_filter,
        identity,
    }
}

#[test]
fn an_empty_identity_accepts_the_entry() {
    let world = FakeWorld::new(&log(), vec![reading(&[spec("A", "one")])]);
    let any = NotificationIdentity::default();
    assert!(locate(&world, wanted(None, &any), deadline()).is_ok());
}

#[test]
fn an_app_filter_that_does_not_match_the_entry_is_not_found() {
    let world = FakeWorld::new(&log(), vec![reading(&[spec("A", "one")])]);
    let any = NotificationIdentity::default();
    let error = locate(&world, wanted(Some("zzz"), &any), deadline())
        .err()
        .expect("none");
    assert_eq!(error.code, ErrorCode::NotificationNotFound);
}

#[test]
fn the_same_words_on_another_object_are_not_the_entry_that_was_read_first() {
    let first = FakeWorld::new(&log(), vec![reading(&[spec("A", "one")])]);
    let any = NotificationIdentity::default();
    let located = locate(&first, wanted(None, &any), deadline()).expect("located");
    let rebuilt = FakeWorld::new(
        &log(),
        vec![reading(&[spec("A", "one").object("A:one#new")])],
    );
    let error = reconfirm(&rebuilt, wanted(None, &any), located.entry(), deadline())
        .err()
        .expect("another object");
    assert_eq!(error.code, ErrorCode::NotificationNotFound);
}
