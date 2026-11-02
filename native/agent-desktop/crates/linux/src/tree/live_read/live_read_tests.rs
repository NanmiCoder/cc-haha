use agent_desktop_core::{AdapterError, Deadline, ErrorCode, NativeHandle};

use super::*;
use crate::tree::live::test_support::read_of;
use crate::tree::observe::node_evidence::evidence_for;
use crate::tree::vocabulary::role_numbers::PUSH_BUTTON;
use crate::tree::{AtspiElement, element::ancestry};

struct Counting {
    answer: Result<Liveness, AdapterError>,
    reads: usize,
    stopped: Option<String>,
    stopped_asked: usize,
    empty_state: bool,
    parent_absence: Option<bool>,
    parent_checks: usize,
    unread_value: bool,
    unread_state: bool,
    tied: bool,
}

impl Counting {
    fn alive() -> Self {
        Self {
            answer: Ok(Liveness::Alive),
            reads: 0,
            stopped: None,
            stopped_asked: 0,
            empty_state: false,
            parent_absence: None,
            parent_checks: 0,
            unread_value: false,
            unread_state: false,
            tied: false,
        }
    }
}

impl NodeReader for Counting {
    fn read(&mut self, element: &AtspiElement) -> Result<NodeEvidence, AdapterError> {
        self.reads += 1;
        let liveness = self.answer.clone()?;
        let mut read = read_of(PUSH_BUTTON, "Save", &["click"]);
        read.node.traits.states =
            crate::tree::Field::Present(crate::tree::live::test_support::words(&[
                crate::tree::vocabulary::state_bits::ENABLED,
                crate::tree::vocabulary::state_bits::SHOWING,
                crate::tree::vocabulary::state_bits::FOCUSED,
            ]));
        if self.empty_state {
            read.node.traits.states = crate::tree::Field::Present(vec![0, 0]);
        }
        if self.unread_value {
            read.value.value = crate::tree::Field::Failed("value unavailable".into());
        }
        if self.unread_state {
            read.node.traits.states = crate::tree::Field::Failed("state unavailable".into());
        }
        Ok(NodeEvidence {
            evidence: evidence_for(&read, element),
            read,
            liveness,
        })
    }

    fn parent_lacks(&mut self, _: &AtspiElement) -> bool {
        self.parent_checks += 1;
        self.parent_absence == Some(true)
    }

    fn stopped_app(&mut self, _pid: u32) -> Option<String> {
        self.stopped_asked += 1;
        self.stopped.clone()
    }

    fn placement(&mut self, _element: &AtspiElement, _deadline: Deadline) -> Placement {
        Placement {
            tie: self
                .tied
                .then_some(crate::tree::surfaces::window_tie::WindowTie {
                    hidden: Some(false),
                }),
            ..Placement::default()
        }
    }

    fn global_position(&mut self, _element: &AtspiElement, _deadline: Deadline) -> bool {
        !self.tied
    }
}

fn handle() -> NativeHandle {
    let mut element = AtspiElement::new(":1.1", "/p", u32::MAX);
    element.set_ancestry(ancestry::of_root(&element.clone()));
    element.into_native_handle()
}

fn kind(error: &AdapterError) -> &str {
    error
        .details
        .as_ref()
        .and_then(|details| details.get("kind"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
}

#[test]
fn a_destroyed_object_and_an_exited_application_are_terminal() {
    for (answer, expected, retryable) in [
        (
            Err(AdapterError::new(ErrorCode::ElementNotFound, "gone")),
            "resolve_target_destroyed",
            false,
        ),
        (
            Err(AdapterError::new(ErrorCode::AppNotFound, "left")),
            "resolve_owning_process_exited",
            false,
        ),
        (Ok(Liveness::ObjectGone), "resolve_target_destroyed", false),
        (
            Ok(Liveness::AppGone),
            "resolve_owning_process_exited",
            false,
        ),
    ] {
        let mut reader = Counting::alive();
        reader.answer = answer;
        let error = read_live(&mut reader, &handle()).expect_err("stale");
        assert_eq!(error.code, ErrorCode::StaleRef);
        assert_eq!(kind(&error), expected);
        assert_eq!(error.is_explicitly_retryable(), retryable);
        assert_eq!(reader.stopped_asked, 0);
    }
}

#[test]
fn a_node_that_did_not_answer_is_a_timeout_and_unresponsive_when_its_process_is_stopped() {
    let mut reader = Counting::alive();
    reader.answer = Ok(Liveness::TimedOut);
    let error = read_live(&mut reader, &handle()).expect_err("timeout");
    assert_eq!(error.code, ErrorCode::Timeout);

    reader.stopped = Some("Calculator".to_owned());
    let error = read_live(&mut reader, &handle()).expect_err("stopped");
    assert_eq!(error.code, ErrorCode::AppUnresponsive);

    let mut slow = Counting::alive();
    slow.answer = Err(AdapterError::timeout("deadline"));
    assert_eq!(
        read_live(&mut slow, &handle()).expect_err("timeout").code,
        ErrorCode::Timeout
    );
}

#[test]
fn a_handle_from_another_platform_or_an_empty_one_is_invalid_args() {
    let mut reader = Counting::alive();
    for foreign in [NativeHandle::new(5u32), NativeHandle::null()] {
        let error = read_live(&mut reader, &foreign).expect_err("invalid");
        assert_eq!(error.code, ErrorCode::InvalidArgs);
        assert_eq!(kind(&error), "invalid_native_handle");
    }
    assert_eq!(reader.reads, 0);
}

#[test]
fn a_pointer_observation_uses_one_fresh_node_for_bounds_and_states() {
    let mut reader = Counting::alive();
    let observation = pointer_via(&mut reader, &handle(), Deadline::standard().unwrap()).unwrap();
    assert_eq!(reader.reads, 1);
    assert_eq!(observation.bounds.unwrap().width, 10.0);
    assert!(
        observation
            .states
            .iter()
            .any(|state| state == agent_desktop_core::tree::state::FOCUSED)
    );
}

#[test]
fn pointer_evidence_does_not_require_a_text_value_but_requires_state() {
    let mut reader = Counting::alive();
    reader.unread_value = true;
    let deadline = Deadline::standard().unwrap();
    let pointer = pointer_via(&mut reader, &handle(), deadline)
        .expect("a text value cannot change the pointer's receiver or visibility");
    assert!(pointer.bounds.is_some());
    assert!(
        pointer
            .states
            .iter()
            .any(|state| state == agent_desktop_core::tree::state::FOCUSED)
    );
    assert!(state_via(&mut reader, &handle(), deadline).is_err());
    reader.unread_state = true;
    let error = pointer_via(&mut reader, &handle(), deadline).unwrap_err();
    assert_eq!(error.code, ErrorCode::AppUnresponsive);
}

#[test]
fn fresh_reads_corroborate_empty_state_with_parent_removal_and_never_with_failed_reads() {
    let mut reader = Counting::alive();
    reader.empty_state = true;
    for absence in [None, Some(false), Some(true)] {
        reader.parent_absence = absence;
        let outcome = read_live(&mut reader, &handle());
        if absence == Some(true) {
            let error = outcome.unwrap_err();
            assert_eq!(error.code, ErrorCode::StaleRef);
            assert_eq!(kind(&error), "resolve_target_destroyed");
        } else {
            assert!(
                outcome.is_ok(),
                "an unread or listing parent is not absence"
            );
        }
    }
    assert_eq!(reader.parent_checks, 3);
    reader.empty_state = false;
    assert!(read_live(&mut reader, &handle()).is_ok());
    assert_eq!(
        reader.parent_checks, 3,
        "healthy state needs no extra parent read"
    );
}

fn tied() -> Counting {
    Counting {
        tied: true,
        ..Counting::alive()
    }
}

#[test]
fn a_pointer_aimed_into_a_tied_window_is_an_ambiguous_target_not_missing_bounds() {
    let deadline = Deadline::after(1_000).expect("deadline");
    let error = pointer_via(&mut tied(), &handle(), deadline).expect_err("pointer");
    assert_eq!(error.code, ErrorCode::AmbiguousTarget);
    assert_eq!(kind(&error), "window_position_ambiguous");
    assert!(!error.is_explicitly_retryable());
    assert_eq!(
        error.disposition,
        agent_desktop_core::DeliverySemantics::not_delivered()
    );
}

#[test]
fn a_tied_window_leaves_the_bounds_read_unanswered_rather_than_refused() {
    let deadline = Deadline::after(1_000).expect("deadline");
    assert_eq!(
        bounds_via(&mut tied(), &handle(), deadline).expect("bounds read"),
        None
    );
}

#[test]
fn a_tied_window_proves_no_pointer_position_and_a_placed_one_proves_nothing() {
    use crate::tree::live_read::pointer_refusal::pointer_refusal_via;
    let deadline = Deadline::after(1_000).expect("deadline");
    let refusal = pointer_refusal_via(&mut tied(), &handle(), deadline)
        .expect("the read answers")
        .expect("a tie is proof");
    assert_eq!(refusal.code, ErrorCode::AmbiguousTarget);
    assert_eq!(kind(&refusal), "window_position_ambiguous");
    let placed =
        pointer_refusal_via(&mut Counting::alive(), &handle(), deadline).expect("the read answers");
    assert!(placed.is_none());
}
