use super::ReleaseGuard;
use crate::input::keyboard::keymap_edit::KeymapEdit;
use crate::input::x11::fake_sink::{FakeSink, Recorded, start_keymap};
use crate::input::x11::held_journal::HeldJournal;
use crate::input::x11::sink_error::SinkError;

fn without_round_trips(sink: &FakeSink) -> Vec<Recorded> {
    sink.recorded()
        .into_iter()
        .filter(|event| *event != Recorded::RoundTrip)
        .collect()
}

fn remap() -> KeymapEdit {
    KeymapEdit {
        keycode: 12,
        keysyms: vec![0x1234, 0x1234],
    }
}

fn restore() -> KeymapEdit {
    KeymapEdit {
        keycode: 12,
        keysyms: vec![0, 0],
    }
}

#[test]
fn failed_restores_remain_recoverable_until_acknowledged() {
    let dir = std::env::temp_dir().join(format!("ad-restore-retry-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let fake = FakeSink::new();
    let mut sink = fake.clone();
    let mut guard = ReleaseGuard::new(&mut sink);
    guard.journal_to(Some(HeldJournal::at(dir.clone(), ":7", 111)));
    let observer = HeldJournal::at(dir.clone(), ":7", 222);
    guard.edit_keymap(&remap()).unwrap();
    fake.world().fail_on_event = Some(2);
    guard
        .edit_keymap(&restore())
        .expect_err("planned restore fails");
    fake.world().fail_on_event = Some(3);
    guard.finish().expect_err("cleanup restore also fails");
    assert_eq!(observer.stale_entries(&|_, _| false)[0].remaps, [restore()]);
    assert_ne!(fake.world().keymap, start_keymap());
    guard.finish().expect("recovery is retried");
    assert_eq!(fake.world().keymap, start_keymap());
    assert!(observer.stale_entries(&|_, _| false).is_empty());
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn keys_are_released_in_the_reverse_order_they_were_pressed() {
    let fake = FakeSink::new();
    let mut sink = fake.clone();
    {
        let mut guard = ReleaseGuard::new(&mut sink);
        guard.key(37, true).expect("ctrl");
        guard.key(50, true).expect("shift");
        guard.key(38, true).expect("a");
    }

    let events = without_round_trips(&fake);
    assert_eq!(
        events[3..],
        [
            Recorded::Key(38, false),
            Recorded::Key(50, false),
            Recorded::Key(37, false)
        ]
    );
}

#[test]
fn a_remap_is_restored_when_the_guard_is_dropped_without_finishing() {
    let fake = FakeSink::new();
    let mut sink = fake.clone();
    {
        let mut guard = ReleaseGuard::new(&mut sink);
        guard.edit_keymap(&remap()).expect("remap");
    }

    assert_eq!(fake.world().keymap, start_keymap());
}

#[test]
fn a_restoring_edit_inside_the_plan_is_not_applied_twice() {
    let fake = FakeSink::new();
    let mut sink = fake.clone();
    let mut guard = ReleaseGuard::new(&mut sink);
    guard.edit_keymap(&remap()).expect("remap");
    guard.edit_keymap(&restore()).expect("restore");
    guard.finish().expect("finish");

    let edits = without_round_trips(&fake)
        .into_iter()
        .filter(|event| matches!(event, Recorded::Keymap(_)))
        .count();
    assert_eq!(edits, 2);
}

#[test]
fn a_press_is_journaled_before_it_is_sent_and_cleared_when_released() {
    let dir = std::env::temp_dir().join(format!("ad-guard-journal-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let fake = FakeSink::new();
    let mut sink = fake.clone();
    let mut guard = ReleaseGuard::new(&mut sink);
    guard.journal_to(Some(HeldJournal::at(dir.clone(), ":7", 111)));
    guard.key(38, true).expect("press");
    let observer = HeldJournal::at(dir, ":7", 222);

    assert_eq!(observer.stale_entries(&|_, _| false).len(), 1);
    guard.key(38, false).expect("release");
    assert!(observer.stale_entries(&|_, _| false).is_empty());
}

#[test]
fn a_press_whose_journal_cannot_be_written_is_not_sent() {
    let dir = std::env::temp_dir().join(format!("ad-guard-blocked-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::write(&dir, "a file where the directory belongs").expect("file");
    let fake = FakeSink::new();
    let mut sink = fake.clone();
    let mut guard = ReleaseGuard::new(&mut sink);
    guard.journal_to(Some(HeldJournal::at(dir, ":7", 111)));

    let error = guard.key(38, true).expect_err("the press is refused");
    drop(guard);

    assert!(matches!(error, SinkError::Journal(_)));
    assert!(without_round_trips(&fake).is_empty());
}

#[test]
fn a_remap_is_journaled_with_the_original_keysyms_before_it_is_sent() {
    let dir = std::env::temp_dir().join(format!("ad-guard-remap-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let fake = FakeSink::new();
    let mut sink = fake.clone();
    let mut guard = ReleaseGuard::new(&mut sink);
    guard.journal_to(Some(HeldJournal::at(dir.clone(), ":7", 111)));
    guard.edit_keymap(&remap()).expect("remap");
    let observer = HeldJournal::at(dir, ":7", 222);

    let pending = observer.stale_entries(&|_, _| false);
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].remaps, [restore()]);
    guard.finish().expect("finish");
    assert!(observer.stale_entries(&|_, _| false).is_empty());
}
