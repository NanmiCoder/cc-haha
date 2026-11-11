use super::{ReachOutcome, retry_until_reached, update};
use agent_desktop_core::{
    CursorOverlayConfig, CursorOverlayControl, CursorOverlayInstruction, CursorOverlayStyle,
    CursorPhase, ErrorCode, Point,
};
use std::time::{Duration, Instant};

fn session() -> String {
    format!("s{:07}", std::process::id() % 10_000_000)
}

fn travel() -> CursorOverlayControl {
    let config =
        CursorOverlayConfig::enabled(Some("open the file".into()), 6).expect("an enabled config");
    let instruction = CursorOverlayInstruction::new(Point { x: 10.0, y: 10.0 }, &config, false)
        .expect("a valid instruction")
        .with_phase(CursorPhase::Travel);
    CursorOverlayControl::present(session(), instruction)
}

/// A `Disable` against a session with no renderer answers `Ok` without
/// starting one. Spawning here would start a renderer in order to tell it to
/// stop, and the same path serves `session end`. A test binary cannot spawn
/// (see the refusal below), so an attempted spawn would surface as the `Err`
/// this `expect` rejects.
#[test]
fn a_disable_with_no_renderer_running_starts_nothing_and_succeeds() {
    update(&CursorOverlayControl::disable(session())).expect("a disable with nothing to disable");
}

/// Dispatch sends `Hide` before and `Show` after every mutating command in a
/// headed overlay-enabled session. Without this refusal such a session would
/// fork a detached renderer per command. An attempted spawn from a test binary
/// would surface as the `Err` these `expect`s reject.
#[test]
fn a_hide_or_show_with_no_renderer_running_starts_nothing() {
    update(&CursorOverlayControl::hide(session())).expect("a hide with nothing to hide");
    update(&CursorOverlayControl::show(session())).expect("a show with nothing to show");
}

/// The spawn guard refuses from any image but the CLI's own, so a test binary
/// and an FFI host never fork a renderer. It refuses with `Err`, not `Ok`,
/// because dispatch turns `Ok` into `rendered: true` - which would claim an
/// overlay that was never started.
#[test]
fn a_control_that_may_spawn_refuses_from_a_test_binary_rather_than_claiming_success() {
    let error = update(&travel()).expect_err("a test binary is not the agent-desktop image");

    assert_eq!(error.code, ErrorCode::PlatformNotSupported);
    assert!(
        error
            .platform_detail
            .as_deref()
            .is_some_and(|detail| detail.contains("agent-desktop")),
        "the refusal names the image it expected, so a reader is not left guessing"
    );
}

#[test]
fn an_enable_refuses_from_a_test_binary_for_the_same_reason() {
    let error = update(&CursorOverlayControl::enable(
        session(),
        CursorOverlayStyle::default(),
    ))
    .expect_err("a test binary is not the agent-desktop image");

    assert_eq!(error.code, ErrorCode::PlatformNotSupported);
}

/// Every attempt gets what is left of the budget, never the budget again.
///
/// Re-issuing the full ceiling per attempt is how a caller promised one
/// arrival timeout waits two: a first reach that spends its ceiling on a
/// renderer that never came up is followed by another with the same ceiling.
///
/// What is asserted is the sequence handed out, not how long the loop took.
/// An elapsed-time bound was tried and is a claim about the scheduler rather
/// than about this code: it failed on a machine busy driving another suite,
/// while the code was correct. The doubling this exists to catch shows up in
/// the sequence anyway - a re-issued ceiling is not smaller than the one
/// before it - so the wall clock adds a way to fail without adding a way to
/// notice the defect.
#[test]
fn each_retry_is_handed_what_is_left_of_the_budget_not_the_whole_budget_again() {
    let budget = Duration::from_millis(1_000);
    let handed = std::cell::RefCell::new(Vec::new());
    let started = Instant::now();

    let error = retry_until_reached(started + budget, |remaining| {
        handed.borrow_mut().push(remaining);
        ReachOutcome::NoRenderer
    })
    .expect_err("nothing ever answers, so the loop must end in a timeout");

    let handed = handed.into_inner();
    assert!(handed.len() > 1, "the loop must actually retry");
    assert!(
        handed[0] <= budget,
        "the first attempt cannot be given more than the whole budget"
    );
    assert!(
        handed.windows(2).all(|pair| pair[1] < pair[0]),
        "each attempt must be given strictly less than the one before it, got {handed:?}"
    );
    assert_eq!(error.code, ErrorCode::Timeout);
    assert!(
        error.message.contains("did not come up within its budget"),
        "an exhausted start-up budget must read as one, got {}",
        error.message
    );
}

/// A budget too nearly spent to be worth a reach must leave by the start-up
/// timeout, not by handing the last sliver to a reach. That reach would report
/// whatever it happened to give up in - an acknowledgement timeout for a
/// renderer that was about to answer, or a `WaitNamedPipeW` of zero
/// milliseconds, which Win32 reads as "use the server's own default" and so
/// parks past the deadline rather than inside it.
///
/// A few milliseconds left rather than none, so this asks a real question: a
/// guard that only caught an exactly-expired deadline would let this through.
#[test]
fn a_budget_too_nearly_spent_to_reach_with_reports_the_start_up_timeout() {
    let mut reached = false;

    let error = retry_until_reached(Instant::now() + Duration::from_millis(4), |_| {
        reached = true;
        ReachOutcome::Delivered
    })
    .expect_err("a budget with nothing usable left cannot be waited out");

    assert!(
        !reached,
        "a reach with less left than a round trip needs is worse than not reaching at all"
    );
    assert_eq!(error.code, ErrorCode::Timeout);
    assert!(error.message.contains("did not come up within its budget"));
}

/// The loop still exits on success, and stops reaching once it has one.
#[test]
fn a_renderer_that_answers_on_a_later_attempt_ends_the_loop() {
    let mut attempts = 0usize;

    retry_until_reached(Instant::now() + Duration::from_secs(2), |_| {
        attempts += 1;
        if attempts < 3 {
            ReachOutcome::NoRenderer
        } else {
            ReachOutcome::Delivered
        }
    })
    .expect("the renderer answered");

    assert_eq!(
        attempts, 3,
        "the loop stops at the answer, it does not run on"
    );
}

/// `broadcast` reaches only the endpoints `discover` can name, and a retired
/// generation's pipe is not one of them - so a teardown that skipped the sweep
/// left the earlier generation's window drawn with nothing left to remove it.
#[test]
fn ending_a_session_sweeps_retired_generations_as_starting_one_does() {
    assert!(super::sweeps_retired_generations(
        &CursorOverlayControl::enable(session(), CursorOverlayStyle::default())
    ));
    assert!(super::sweeps_retired_generations(
        &CursorOverlayControl::disable(session())
    ));
    assert!(
        !super::sweeps_retired_generations(&CursorOverlayControl::hide(session())),
        "a control inside a live session must not reach retired pipes"
    );
}
