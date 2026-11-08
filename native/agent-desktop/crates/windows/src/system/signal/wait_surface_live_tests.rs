//! Windows-only: drives `agent_desktop_core::commands::wait::execute` end to
//! end for `surface-appeared` / `surface-dismissed`, including the
//! unnamed-surface-discovery proof: a `ModalFixture` dialog opened mid-wait,
//! discovered without the caller naming its title or id.
//!
//! Core rejects a surface event without `--app` (`wait_mode.rs:168-177`),
//! but every wait here seeds `CommandContext` with a `capture_signal_baseline`
//! already scoped to the fixture's own `(pid, process_instance)`
//! (`context::with_event_baseline`), so core's `signal_filter` resolves
//! `--app` from that seed via `process_from_baseline` rather than calling
//! `resolve_app` (`wait_event.rs:120-131`). A process-filtered capture can
//! contain at most this one fixture, so the `AMBIGUOUS_TARGET` every other
//! fixture-spawning test in this binary sharing the same re-exec'd image
//! name could otherwise trigger (`wait_event_live_tests.rs`'s module doc
//! explains the hazard) does not arise for this test's own resolution
//! regardless of what else is running concurrently. Each test below still
//! holds `test_support::FIXTURE_APP_NAME_LOCK` for its own `ModalFixture`'s
//! entire lifetime anyway, not to protect itself but so that fixture cannot
//! coexist with a concurrently running `list_apps`-by-name-resolving test
//! (`wait --menu`, `app-launched`) and defeat that other test's resolution.
//!
//! `signal_surfaces_tests.rs` already proves the adapter method's own
//! stability and id properties directly; this file is the layer above it,
//! through the real command a caller actually runs.
#![cfg(target_os = "windows")]

use std::sync::mpsc::channel;
use std::thread;
use std::time::Duration;

use agent_desktop_core::commands::wait::{self, WaitArgs, WaitModeArgs, WaitPredicateArgs};
use agent_desktop_core::{
    AppError, CommandContext, Deadline, ProcessId, ProcessIdentity, SignalBaseline, SignalFilter,
    SystemOps,
};
use serde_json::Value;

use crate::adapter::WindowsAdapter;
use crate::system::fixture::test_support::FIXTURE_APP_NAME_LOCK;
use crate::tree::fixture::bootstrap;
use crate::tree::fixture::fixture_modal::ModalFixture;

const TRANSITION_AFTER: Duration = Duration::from_millis(400);
const RECV_TIMEOUT: Duration = Duration::from_secs(20);
const FIXTURE_STATE_TIMEOUT: Duration = Duration::from_secs(5);
const WAIT_TIMEOUT_MS: u64 = 10_000;
const SURFACE_SETTLE_TIMEOUT: Duration = Duration::from_secs(5);
const SURFACE_SETTLE_POLL: Duration = Duration::from_millis(50);

use crate::system::fixture::live_identity::own_image_name;

fn process_identity_for(pid: u32) -> ProcessIdentity {
    crate::system::fixture::live_identity::live_process_identity(ProcessId::from(pid))
}

fn scoped_baseline(identity: &ProcessIdentity) -> SignalBaseline {
    let filter = SignalFilter {
        app: None,
        process: Some(identity.clone()),
    };
    WindowsAdapter::new()
        .capture_signal_baseline(&filter, Deadline::after(5_000).expect("bounded deadline"))
        .expect("a process-filtered capture on a live desktop must succeed")
}

/// Polls a real, process-filtered capture until the fixture's modal is
/// observable as a Sheet surface on two consecutive reads, and returns that
/// last verified capture so it can be used directly as the wait's seed -
/// never sleeping a fixed span and never trusting a single read, since a
/// property that is still settling can produce a false positive on its
/// first observed occurrence. `wait_for_modal_state(true, ...)` only
/// confirms the fixture's own `ShowWindow` call returned, not that a UI
/// Automation `WindowIsModal` read against it has caught up.
fn settled_sheet_baseline(identity: &ProcessIdentity) -> SignalBaseline {
    let deadline = std::time::Instant::now() + SURFACE_SETTLE_TIMEOUT;
    let mut consecutive = 0u32;
    loop {
        let baseline = scoped_baseline(identity);
        if !baseline.surfaces.is_empty() {
            consecutive += 1;
            if consecutive >= 2 {
                return baseline;
            }
        } else {
            consecutive = 0;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "the fixture's modal never became observably stable as a Sheet surface"
        );
        thread::sleep(SURFACE_SETTLE_POLL);
    }
}

fn event_wait(event: &str, app: String, seed: SignalBaseline) -> Result<Value, AppError> {
    let args = WaitArgs {
        mode: WaitModeArgs {
            event: Some(event.to_string()),
            ..WaitModeArgs::default()
        },
        predicate: WaitPredicateArgs {
            predicate: None,
            value: None,
            action: None,
            count: None,
        },
        timeout_ms: WAIT_TIMEOUT_MS,
        app: Some(app),
    };
    let context = CommandContext::default().with_event_baseline(Some(Ok(seed)));
    let adapter = WindowsAdapter::new();
    wait::execute(args, &adapter, &context)
}

fn spawn_event_wait(
    event: &'static str,
    app: String,
    seed: SignalBaseline,
) -> std::sync::mpsc::Receiver<Result<Value, AppError>> {
    let (sender, receiver) = channel();
    thread::spawn(move || {
        let _ = sender.send(event_wait(event, app, seed));
    });
    receiver
}

fn found_event(outcome: Result<Value, AppError>) -> Value {
    let body = outcome.expect("the wait must find the requested event rather than time out");
    assert_eq!(body["found"], Value::Bool(true));
    assert!(
        body["elapsed_ms"].is_number(),
        "the success envelope must carry elapsed_ms, the shape macOS's own wait success \
         payload carries: {body}"
    );
    body["event"].clone()
}

/// `--app` is required by core for a surface event
/// (`wait_mode.rs:168-177`) - that is a scoping mechanism, not the title or
/// id this test proves the caller never has to name - so the modal's own
/// identity is entirely server-supplied.
#[test]
fn surface_appeared_fires_for_a_modal_opened_mid_wait_with_no_title_or_id_supplied() {
    bootstrap();
    let _app_name_scope = FIXTURE_APP_NAME_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let fixture = ModalFixture::spawn().expect("the modal fixture starts");
    let identity = process_identity_for(fixture.process_id());
    let seed = scoped_baseline(&identity);
    let receiver = spawn_event_wait("surface-appeared", own_image_name(), seed);

    thread::sleep(TRANSITION_AFTER);
    fixture.open();
    assert!(fixture.wait_for_modal_state(true, FIXTURE_STATE_TIMEOUT));

    let outcome = receiver
        .recv_timeout(RECV_TIMEOUT)
        .expect("the wait completed");
    let event = found_event(outcome);
    assert_eq!(event["surface"], "sheet");
    assert!(
        event["pid"].is_number() && event["app"].is_string(),
        "the surface's owning process must be server-supplied even though the caller named \
         neither a title nor an id: {event}"
    );
}

#[test]
fn surface_dismissed_fires_when_the_already_open_modal_closes_mid_wait() {
    bootstrap();
    let _app_name_scope = FIXTURE_APP_NAME_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let fixture = ModalFixture::spawn().expect("the modal fixture starts");
    fixture.open();
    assert!(fixture.wait_for_modal_state(true, FIXTURE_STATE_TIMEOUT));
    let identity = process_identity_for(fixture.process_id());
    let seed = settled_sheet_baseline(&identity);

    let receiver = spawn_event_wait("surface-dismissed", own_image_name(), seed);

    thread::sleep(TRANSITION_AFTER);
    fixture.close();
    assert!(fixture.wait_for_modal_state(false, FIXTURE_STATE_TIMEOUT));

    let outcome = receiver
        .recv_timeout(RECV_TIMEOUT)
        .expect("the wait completed");
    let event = found_event(outcome);
    assert_eq!(event["surface"], "sheet");
}
