//! Two overlaid actions in a row, measured from the sender's side.
//!
//! Every semantic action that draws a cursor sends two controls: a travel the
//! action blocks on before it dispatches, and a flourish after the dispatch
//! confirms. So a second action begins by asking the renderer to travel while
//! the first one's flourish is still playing, and the renderer serves one
//! control at a time over one pipe instance.
//!
//! What that used to mean is measured here rather than reasoned about: the
//! flourish held the connection for its whole hold, the travel behind it spent
//! its entire arrival budget on `ERROR_PIPE_BUSY`, and the action reported
//! that nothing had rendered. Nothing failed loudly - back-to-back actions
//! simply stopped drawing a cursor, which is the failure a fail-soft path is
//! built to produce and the reason it needs a test with a clock in it.
//!
//! The controls are sent through the adapter rather than the CLI because the
//! CLI has no way to ask for one: `cursor-overlay` offers enable and disable,
//! and a travel or a flourish only ever comes from an action's own dispatch.
//! Driving a real click twice would put a fixture app's settle time inside the
//! measurement, and the number asserted here is meant to be the renderer's.

use super::support::{
    Scratch, enable, oracle_pixels, run, skip_unless_live_staging, start_session, wait_until,
};
use agent_desktop_core::{
    CURSOR_HIGHLIGHT_HOLD_MS, CursorOverlayConfig, CursorOverlayControl, CursorOverlayInstruction,
    CursorOverlayStyle, CursorPhase, Point, SystemOps,
};
use std::time::{Duration, Instant};

/// Where both controls point. The same point for each is deliberate: a travel
/// with nowhere to go has no motion of its own, so what is left on the clock
/// is the wait for the renderer to become free.
const DESTINATION: Point = Point { x: 400.0, y: 400.0 };

const WORD_LIMIT: usize = 6;

/// Half the flourish's hold, which is tighter than the arrival budget on
/// purpose.
///
/// Disconnecting before the flourish is only half the fix. With the
/// connection released but the flourish still playing out its full hold, the
/// travel is written straight away and answered when the hold ends - a little
/// under the 900ms budget, so an assertion pitched at the budget would sit on
/// that boundary and pass while the flourish still owned the renderer. Half
/// the hold is past what the flourish can deliver and still an order of
/// magnitude above what a renderer that gives way actually takes.
const BUDGET: Duration = Duration::from_millis(CURSOR_HIGHLIGHT_HOLD_MS / 2);

fn present(
    session: &str,
    config: &CursorOverlayConfig,
    click: bool,
    phase: CursorPhase,
) -> CursorOverlayControl {
    let instruction = CursorOverlayInstruction::new(DESTINATION, config, click)
        .expect("the instruction is well formed")
        .with_phase(phase);
    CursorOverlayControl::present_with_style(
        session.to_owned(),
        instruction,
        CursorOverlayStyle::default(),
    )
}

#[test]
fn a_travel_behind_a_flourish_is_answered_without_waiting_the_flourish_out() {
    if skip_unless_live_staging("cursor overlay back-to-back dispatch") {
        return;
    }
    let scratch = Scratch::create("dispatch");
    let session = start_session(&scratch);

    let enabled = enable(&scratch, &session);
    assert_eq!(enabled["ok"], true, "the overlay must enable: {enabled}");
    assert_eq!(
        enabled["data"]["rendered"], true,
        "the renderer must acknowledge before anything is timed against it, or this measures a renderer that never started: {enabled}"
    );
    wait_until("the overlay painted its oracle colour", || {
        oracle_pixels() > 0
    });

    let config = CursorOverlayConfig::enabled(Some("Clicking the button".into()), WORD_LIMIT)
        .expect("the overlay configuration is well formed");
    let flourish = present(&session, &config, true, CursorPhase::Effect);
    let travel = present(&session, &config, false, CursorPhase::Travel);

    let (delivered, acknowledged, waited) = with_state_root(&scratch, || {
        let adapter = agent_desktop_windows::WindowsAdapter::new();
        let delivered = adapter.update_cursor_overlay(&flourish);
        let started = Instant::now();
        let acknowledged = adapter.update_cursor_overlay(&travel);
        (delivered, acknowledged, started.elapsed())
    });

    let _ = run(
        &scratch,
        &["cursor-overlay", "disable", "--session", &session],
    );

    assert!(
        delivered.is_ok(),
        "the flourish must reach the renderer: {:?}",
        delivered.err()
    );
    assert!(
        acknowledged.is_ok(),
        "the travel behind a flourish must still be acknowledged, and was not after {waited:?}: {:?}",
        acknowledged.err()
    );
    assert!(
        waited < BUDGET,
        "the travel took {waited:?}, which is long enough that the flourish in front of it was still holding the renderer"
    );
}

/// Points this process at the same state root the CLI calls were given, so the
/// pipe name derived in-process names the renderer those calls started.
///
/// The variable is process-wide, which is safe here only because this target
/// runs on one test thread: its tests share one desktop and one oracle colour,
/// so they could never have run beside each other anyway.
fn with_state_root<T>(scratch: &Scratch, measure: impl FnOnce() -> T) -> T {
    unsafe { std::env::set_var("AGENT_DESKTOP_HOME", &scratch.root) };
    let measured = measure();
    unsafe { std::env::remove_var("AGENT_DESKTOP_HOME") };
    measured
}
