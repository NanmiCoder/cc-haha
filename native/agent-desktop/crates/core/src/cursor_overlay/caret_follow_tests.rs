use super::settled_caret;
use crate::adapter::{ActionOps, InputOps, ObservationOps, SystemOps};
use crate::{AdapterError, CommandContext, CursorOverlayControl, CursorPhase, Rect};
use std::cell::Cell;
use std::sync::Mutex;
use std::time::Duration;

fn caret_at(x: f64) -> Rect {
    Rect {
        x,
        y: 10.0,
        width: 2.0,
        height: 16.0,
    }
}

#[test]
fn the_caret_is_read_until_the_app_has_moved_the_insertion_point() {
    let reads = [
        caret_at(40.0),
        caret_at(64.0),
        caret_at(64.0),
        caret_at(64.0),
    ];
    let index = Cell::new(0);

    let settled = settled_caret(
        |_| {
            let read = reads[index.get().min(reads.len() - 1)];
            index.set(index.get() + 1);
            Ok(Some(read))
        },
        Duration::from_millis(25),
    );

    assert_eq!(settled, Some(Some(caret_at(64.0))));
}

#[test]
fn a_focused_element_without_an_insertion_point_settles_on_none() {
    assert_eq!(
        settled_caret(|_| Ok(None), Duration::from_millis(25)),
        Some(None)
    );
}

#[test]
fn an_adapter_that_cannot_read_the_focused_caret_leaves_the_caret_alone() {
    assert_eq!(
        settled_caret(
            |_| Err(AdapterError::not_supported("get_focused_insertion_caret")),
            Duration::from_millis(25),
        ),
        None
    );
}

struct FocusedCaretAdapter {
    caret: Result<Option<Rect>, ()>,
    presented: Mutex<Vec<CursorOverlayControl>>,
}

impl ObservationOps for FocusedCaretAdapter {
    fn get_focused_insertion_caret(
        &self,
        _process: Option<crate::ProcessId>,
        _deadline: crate::Deadline,
    ) -> Result<Option<Rect>, AdapterError> {
        self.caret
            .map_err(|()| AdapterError::not_supported("get_focused_insertion_caret"))
    }
}
impl ActionOps for FocusedCaretAdapter {}
impl InputOps for FocusedCaretAdapter {}
impl SystemOps for FocusedCaretAdapter {
    fn update_cursor_overlay(&self, control: &CursorOverlayControl) -> Result<(), AdapterError> {
        self.presented.lock().unwrap().push(control.clone());
        Ok(())
    }
}

fn presented_after_key(caret: Result<Option<Rect>, ()>) -> Vec<CursorOverlayControl> {
    let adapter = FocusedCaretAdapter {
        caret,
        presented: Mutex::new(Vec::new()),
    };
    let config = crate::CursorOverlayConfig::enabled(None, 6).expect("valid config");
    let context = CommandContext::default().with_cursor_overlay_session("test-session", config);
    super::follow_caret_after_key(&adapter, &context, Some(crate::ProcessId::new(42)));
    adapter.presented.into_inner().unwrap()
}

#[test]
fn a_key_press_moves_a_showing_caret_to_the_new_insertion_point() {
    let presented = presented_after_key(Ok(Some(caret_at(64.0))));

    assert_eq!(presented.len(), 1);
    let instruction = presented[0].instruction().expect("a caret instruction");
    assert_eq!(instruction.phase(), CursorPhase::CaretFollow);
    assert_eq!(instruction.target(), Some(&caret_at(64.0)));
    assert!(presented[0].expects_acknowledgement());
}

#[test]
fn a_key_press_that_leaves_no_insertion_point_hides_the_caret() {
    let presented = presented_after_key(Ok(None));

    let instruction = presented[0].instruction().expect("a caret instruction");
    assert_eq!(instruction.phase(), CursorPhase::CaretFollow);
    assert!(instruction.target().is_none());
}

#[test]
fn a_key_press_sends_nothing_when_the_adapter_cannot_read_the_caret() {
    assert!(presented_after_key(Err(())).is_empty());
}

/// A renderer that has rested has already cleared its caret, so it must be
/// able to tell a caret-follow from a control that should wake it.
#[test]
fn a_caret_follow_is_told_apart_from_controls_that_wake_the_overlay() {
    let presented = presented_after_key(Ok(Some(caret_at(64.0))));
    assert!(presented[0].is_caret_follow());

    let config = crate::CursorOverlayConfig::enabled(None, 6).expect("valid config");
    let travel =
        crate::CursorOverlayInstruction::new(crate::Point { x: 1.0, y: 1.0 }, &config, false)
            .expect("valid instruction");
    assert!(!CursorOverlayControl::present("test-session".into(), travel).is_caret_follow());
}
