//! Teardown, proved by observing the desktop rather than by reading the
//! disable command's own answer.
//!
//! `cursor-overlay disable` returning `ok` is the claim under test, so it
//! cannot also be the evidence. Three independent observations stand in for
//! it: the renderer process is gone, the pipe name can be claimed again, and
//! the pixels the overlay painted are no longer on screen.
//!
//! The pipe observation is made through the product rather than by opening
//! the name directly. A test that composed the name itself could drift from
//! the renderer's own derivation and pass while the name was never released;
//! asking the CLI to enable again, and requiring a renderer with a *different*
//! process id, exercises the exact claim path a real caller depends on — a
//! held name makes the fresh child withdraw and the enable time out.

#![cfg(target_os = "windows")]

#[path = "screen_sample.rs"]
mod screen_sample;

#[path = "windows_cursor_overlay_support.rs"]
mod support;

/// Back-to-back dispatch shares this target rather than claiming one of its
/// own, because the suite that stages a readable desktop names its test
/// targets one by one: a new target would build and never run.
#[path = "windows_cursor_overlay_dispatch.rs"]
mod dispatch;

use support::{
    PROMPTLY, Scratch, enable, oracle_pixels, overlay_children, run, skip_unless_live_staging,
    start_session, wait_until, wait_within,
};

#[test]
fn disabling_leaves_no_process_no_held_name_and_no_pixels() {
    if skip_unless_live_staging("cursor overlay teardown") {
        return;
    }
    let scratch = Scratch::create("teardown");
    let session = start_session(&scratch);

    let enabled = enable(&scratch, &session);
    assert_eq!(enabled["ok"], true, "the overlay must enable: {enabled}");
    assert_eq!(
        enabled["data"]["rendered"], true,
        "the renderer must acknowledge before any pixel is waited on, or a renderer that never started is reported as an overlay that never painted: {enabled}"
    );
    wait_until("the overlay painted its oracle colour", || {
        oracle_pixels() > 0
    });
    let children = overlay_children(&session);
    assert_eq!(
        children.len(),
        1,
        "exactly one renderer serves a session, got {children:?}"
    );
    let first = children[0];

    let disabled = run(
        &scratch,
        &["cursor-overlay", "disable", "--session", &session],
    );
    assert_eq!(disabled["ok"], true, "the overlay must disable: {disabled}");

    wait_within(PROMPTLY, "the renderer process ended", || {
        overlay_children(&session).is_empty()
    });
    wait_within(PROMPTLY, "the overlay pixels left the screen", || {
        oracle_pixels() == 0
    });

    let again = enable(&scratch, &session);
    assert_eq!(
        again["ok"], true,
        "a fresh enable must claim the released name: {again}"
    );
    wait_until("a replacement renderer started", || {
        !overlay_children(&session).is_empty()
    });
    let replacement = overlay_children(&session);
    assert_eq!(replacement.len(), 1, "still exactly one renderer");
    assert_ne!(
        replacement[0], first,
        "the replacement must be a new process; the same pid would mean nothing was torn down"
    );

    let _ = run(
        &scratch,
        &["cursor-overlay", "disable", "--session", &session],
    );
}

/// `session end` dispatches a disable of its own, so this covers that wiring
/// rather than the renderer's session watch. The watch is what the following
/// test exercises, and the two are deliberately separate: a single test
/// calling `session end` would pass on the dispatched disable alone and prove
/// nothing about an abandoned renderer.
#[test]
fn ending_the_session_through_the_cli_also_takes_the_overlay_down() {
    if skip_unless_live_staging("cursor overlay session-end reclaim") {
        return;
    }
    let scratch = Scratch::create("session-end");
    let session = start_session(&scratch);

    let enabled = enable(&scratch, &session);
    assert_eq!(enabled["ok"], true, "the overlay must enable: {enabled}");
    assert_eq!(
        enabled["data"]["rendered"], true,
        "the renderer must acknowledge before any pixel is waited on, or a renderer that never started is reported as an overlay that never painted: {enabled}"
    );
    wait_until("the overlay painted its oracle colour", || {
        oracle_pixels() > 0
    });

    let ended = run(&scratch, &["session", "end", "--session", &session]);
    assert_eq!(ended["ok"], true, "the session must end: {ended}");

    wait_until("the abandoned renderer ended itself", || {
        overlay_children(&session).is_empty()
    });
    wait_until("the abandoned overlay left the screen", || {
        oracle_pixels() == 0
    });
}

/// The case nothing else covers: a session that ends without any `disable`
/// reaching the renderer — a crashed agent, a `session gc`, an operator who
/// simply stops. The manifest is marked ended in place, exactly as an
/// out-of-band ending leaves it, and no command is run.
///
/// The renderer has no console, no taskbar entry and no Alt-Tab presence, so
/// if it did not notice this for itself, nothing in the product could remove
/// it. Reclaim is bounded by the two consecutive readings the watch requires,
/// which is what stops one unreadable tick ending a healthy overlay.
#[test]
fn a_session_ended_out_of_band_reclaims_its_abandoned_renderer() {
    if skip_unless_live_staging("cursor overlay out-of-band reclaim") {
        return;
    }
    let scratch = Scratch::create("out-of-band");
    let session = start_session(&scratch);

    let enabled = enable(&scratch, &session);
    assert_eq!(enabled["ok"], true, "the overlay must enable: {enabled}");
    assert_eq!(
        enabled["data"]["rendered"], true,
        "the renderer must acknowledge before any pixel is waited on, or a renderer that never started is reported as an overlay that never painted: {enabled}"
    );
    wait_until("the overlay painted its oracle colour", || {
        oracle_pixels() > 0
    });

    let manifest = scratch
        .root
        .join("sessions")
        .join(&session)
        .join(agent_desktop_core::session::SESSION_MANIFEST_FILE);
    let mut body: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(&manifest).expect("the manifest is readable"),
    )
    .expect("the manifest parses");
    body["ended_at"] = serde_json::json!(1_788_000_000_000u64);
    std::fs::write(
        &manifest,
        serde_json::to_string_pretty(&body).expect("the manifest re-serializes"),
    )
    .expect("the manifest is writable");

    wait_until("the abandoned renderer ended itself", || {
        overlay_children(&session).is_empty()
    });
    wait_until("the abandoned overlay left the screen", || {
        oracle_pixels() == 0
    });
}

/// Renderers are per session, and the pipe name carries the session id. A
/// disable aimed at a different session must not reach this one, or one
/// agent's teardown would blank another's overlay.
#[test]
fn a_disable_for_another_session_leaves_this_overlay_alone() {
    if skip_unless_live_staging("cursor overlay session scoping") {
        return;
    }
    let scratch = Scratch::create("scoping");
    let mine = start_session(&scratch);
    let theirs = start_session(&scratch);

    let enabled = enable(&scratch, &mine);
    assert_eq!(enabled["ok"], true, "the overlay must enable: {enabled}");
    assert_eq!(
        enabled["data"]["rendered"], true,
        "the renderer must acknowledge before any pixel is waited on, or a renderer that never started is reported as an overlay that never painted: {enabled}"
    );
    wait_until("the overlay painted its oracle colour", || {
        oracle_pixels() > 0
    });

    let elsewhere = run(
        &scratch,
        &["cursor-overlay", "disable", "--session", &theirs],
    );
    assert_eq!(
        elsewhere["ok"], true,
        "disabling a session with no renderer is not an error: {elsewhere}"
    );

    assert_eq!(
        overlay_children(&mine).len(),
        1,
        "the other session's disable must not have ended this renderer"
    );
    assert!(
        oracle_pixels() > 0,
        "the other session's disable must not have cleared this overlay"
    );

    let _ = run(&scratch, &["cursor-overlay", "disable", "--session", &mine]);
}
