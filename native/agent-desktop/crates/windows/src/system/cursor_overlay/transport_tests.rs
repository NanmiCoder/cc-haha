use super::{ReachOutcome, reach};
use agent_desktop_core::{CursorOverlayControl, CursorOverlayStyle};
use std::time::Duration;

/// A name nothing is serving must read as "no renderer", not as a failure -
/// it is the ordinary state before the first enable of a session, and the
/// only state from which spawning is correct.
#[test]
fn a_name_nobody_serves_reports_no_renderer_rather_than_an_error() {
    let control = CursorOverlayControl::enable("s0000001".into(), CursorOverlayStyle::default());

    let outcome = reach(
        r"\\.\pipe\agent-desktop-cursor-nothing-serves-this",
        &control,
        Duration::from_millis(50),
    );

    assert!(
        matches!(outcome, ReachOutcome::NoRenderer),
        "an absent renderer must be distinguishable from an unreachable one, or the caller \
         either forks a duplicate or never starts one at all"
    );
}

/// The budget bounds the attempt. A caller that could be held past its own
/// deadline here is the clipboard defect this crate carries a guard for,
/// reappearing in the renderer that is meant to be fail-soft.
#[test]
fn an_absent_renderer_answers_well_inside_the_budget() {
    let control = CursorOverlayControl::disable("s0000001".into());
    let started = std::time::Instant::now();

    let _ = reach(
        r"\\.\pipe\agent-desktop-cursor-nothing-serves-this-either",
        &control,
        Duration::from_millis(400),
    );

    assert!(
        started.elapsed() < Duration::from_millis(50),
        "a not-found answer is immediate. The bound sits far below the 400ms budget on \
         purpose: the regression it guards against is falling into the busy-retry loop, \
         which runs to the deadline, so a bound equal to the budget would be a coin flip \
         against itself"
    );
}

/// A `ReadFile` that succeeded and returned the wrong payload is a framing
/// failure. Reporting it through `GetLastError` printed "Win32 error 0",
/// which names no cause at all and sends a reader looking for an OS fault
/// that never happened.
#[cfg(target_os = "windows")]
#[test]
fn an_unexpected_answer_is_described_by_what_was_read_not_by_an_errno() {
    let short = super::imp::unexpected_answer(0, 0);
    let wrong = super::imp::unexpected_answer(1, 0x5a);

    for error in [&short, &wrong] {
        assert_eq!(error.code, agent_desktop_core::ErrorCode::Internal);
        let detail = error
            .platform_detail
            .as_deref()
            .expect("a framing failure says what came back");
        assert!(
            !detail.contains("Win32 error"),
            "a successful read that answered wrongly is not an OS error: {detail}"
        );
    }

    let short_detail = short.platform_detail.as_deref().unwrap_or_default();
    assert!(
        short_detail.contains("read 0 bytes"),
        "the byte count is what went wrong when nothing was read: {short_detail}"
    );
    assert!(
        !short_detail.contains("0x00"),
        "no byte was read, so no byte value may be quoted as the answer: {short_detail}"
    );

    let wrong_detail = wrong.platform_detail.as_deref().unwrap_or_default();
    assert!(
        wrong_detail.contains("0x5a"),
        "the byte that came back is the whole finding: {wrong_detail}"
    );
}
