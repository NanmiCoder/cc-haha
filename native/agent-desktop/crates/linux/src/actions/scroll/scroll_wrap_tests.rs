use agent_desktop_core::{AdapterError, Deadline, ErrorCode};

use super::{ScrollPort, Visibility, scroll_with};

struct Port {
    reads: Vec<Visibility>,
    scroll: Option<AdapterError>,
    scrolls: usize,
    delivered: bool,
}

impl Port {
    fn new(reads: &[Visibility]) -> Self {
        Self {
            reads: reads.iter().rev().copied().collect(),
            scroll: None,
            scrolls: 0,
            delivered: true,
        }
    }
}

impl ScrollPort for Port {
    fn visibility(&mut self) -> Visibility {
        self.reads.pop().unwrap_or(Visibility::Unread)
    }

    fn scroll(&mut self) -> Result<bool, AdapterError> {
        self.scrolls += 1;
        match self.scroll.take() {
            Some(error) => Err(error),
            None => Ok(self.delivered),
        }
    }
}

fn deadline() -> Deadline {
    Deadline::after(5_000).expect("a deadline")
}

fn first_step(result: &agent_desktop_core::ActionResult) -> (Option<bool>, usize) {
    (result.steps[0].verified(), result.steps.len())
}

#[test]
fn a_target_already_on_screen_is_satisfied_and_never_scrolled() {
    let mut port = Port::new(&[Visibility::OnScreen]);
    let result = scroll_with(&mut port, deadline()).expect("satisfied");
    assert_eq!(port.scrolls, 0);
    assert_eq!(first_step(&result), (Some(true), 1));
}

#[test]
fn an_ok_routine_with_the_target_still_off_screen_is_not_a_success() {
    let mut port = Port::new(&[Visibility::OffScreen, Visibility::OffScreen]);
    let result = scroll_with(&mut port, deadline()).expect("delivered");
    assert_eq!(first_step(&result), (Some(false), 1));
}

#[test]
fn an_unreadable_after_read_carries_no_verified() {
    let mut port = Port::new(&[Visibility::OffScreen, Visibility::Unread]);
    let result = scroll_with(&mut port, deadline()).expect("delivered");
    assert_eq!(first_step(&result), (None, 1));
}

#[test]
fn an_unreadable_before_read_still_calls_the_routine_and_judges_by_the_after_read() {
    let mut port = Port::new(&[Visibility::Unread, Visibility::OnScreen]);
    let result = scroll_with(&mut port, deadline()).expect("delivered");
    assert_eq!(port.scrolls, 1);
    assert_eq!(first_step(&result), (Some(true), 1));
}

#[test]
fn an_error_from_the_routine_is_returned_unchanged() {
    let mut port = Port::new(&[Visibility::OffScreen]);
    port.scroll = Some(AdapterError::new(ErrorCode::ActionNotSupported, "no route"));
    let error = scroll_with(&mut port, deadline()).expect_err("refused");
    assert_eq!(error.code, ErrorCode::ActionNotSupported);
    assert_eq!(error.message, "no route");
}

#[test]
fn a_ladder_that_finds_the_target_satisfied_does_not_claim_delivery() {
    let mut port = Port::new(&[Visibility::OffScreen]);
    port.delivered = false;
    let result = scroll_with(&mut port, deadline()).expect("already satisfied at ladder preflight");
    assert_eq!(
        result.disposition(),
        agent_desktop_core::DeliverySemantics::not_delivered()
    );
    assert_eq!(port.scrolls, 1);
}
