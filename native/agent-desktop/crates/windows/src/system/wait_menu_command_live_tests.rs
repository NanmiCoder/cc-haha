//! Windows-only: drives `agent_desktop_core::commands::wait::execute` end to
//! end for `--menu` / `--menu-closed` against a real `MenuFixture`.
//! `wait_tests.rs` beside this file already proves the adapter's own
//! `wait_for_menu` loop directly; this file is the layer above it, through
//! `WaitMode::from_args`'s `SurfaceWait` routing and the command a caller
//! actually runs.
//!
//! `wait --menu` resolves its target by `--app` exactly as `wait_for_menu`
//! (core `commands/wait.rs`) requires, so both tests here hold
//! `test_support::FIXTURE_APP_NAME_LOCK` for the fixture's entire lifetime -
//! see that module's doc comment for the hazard it closes.
#![cfg(target_os = "windows")]

use std::sync::mpsc::channel;
use std::thread;
use std::time::Duration;

use agent_desktop_core::commands::wait::{self, WaitArgs, WaitModeArgs, WaitPredicateArgs};
use agent_desktop_core::commands::wait_surface::SurfaceWait;
use agent_desktop_core::{AppError, CommandContext};
use serde_json::Value;

use crate::adapter::WindowsAdapter;
use crate::system::fixture::test_support::FIXTURE_APP_NAME_LOCK;
use crate::tree::fixture::bootstrap;
use crate::tree::fixture::fixture_menu::MenuFixture;

const OPEN_AFTER: Duration = Duration::from_millis(300);
const RECV_TIMEOUT: Duration = Duration::from_secs(20);
const STATE_TIMEOUT: Duration = Duration::from_secs(5);
const WAIT_TIMEOUT_MS: u64 = 10_000;

use crate::system::fixture::live_identity::own_image_name;

const AMBIGUOUS_APP_NAME_RETRIES: u32 = 10;
const AMBIGUOUS_APP_NAME_RETRY_DELAY: Duration = Duration::from_millis(300);

/// `FIXTURE_APP_NAME_LOCK` bounds collisions between the live-test files
/// that know about it; this retry absorbs the residual, genuinely transient
/// case where an unrelated already-shipped test elsewhere in this same
/// binary has a same-named fixture alive for a moment.
fn is_ambiguous_app_name(outcome: &Result<Value, AppError>) -> bool {
    matches!(
        outcome,
        Err(AppError::Adapter(error)) if error.code == agent_desktop_core::ErrorCode::AmbiguousTarget
    )
}

fn retrying_ambiguous_app_name(
    mut attempt: impl FnMut() -> Result<Value, AppError>,
) -> Result<Value, AppError> {
    let mut outcome = attempt();
    for _ in 1..AMBIGUOUS_APP_NAME_RETRIES {
        if !is_ambiguous_app_name(&outcome) {
            break;
        }
        thread::sleep(AMBIGUOUS_APP_NAME_RETRY_DELAY);
        outcome = attempt();
    }
    outcome
}

fn menu_wait(surface: SurfaceWait, app: String) -> Result<Value, AppError> {
    let args = WaitArgs {
        mode: WaitModeArgs {
            surface: Some(surface),
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
    let adapter = WindowsAdapter::new();
    retrying_ambiguous_app_name(|| {
        wait::execute(args.clone(), &adapter, &CommandContext::default())
    })
}

fn spawn_menu_wait(
    surface: SurfaceWait,
    app: String,
) -> std::sync::mpsc::Receiver<Result<Value, AppError>> {
    let (sender, receiver) = channel();
    thread::spawn(move || {
        let _ = sender.send(menu_wait(surface, app));
    });
    receiver
}

#[test]
fn wait_menu_finds_the_fixtures_context_menu_opened_mid_wait_through_the_command_layer() {
    bootstrap();
    let _app_name_scope = FIXTURE_APP_NAME_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let _stage = crate::tree::fixture::fixture_window::on_screen_stage();
    let fixture = MenuFixture::spawn().expect("the menu fixture starts");
    let receiver = spawn_menu_wait(SurfaceWait::Menu, own_image_name());

    thread::sleep(OPEN_AFTER);
    fixture.open_context_menu();
    assert!(fixture.wait_for_menu_state(true, STATE_TIMEOUT));

    let outcome = receiver
        .recv_timeout(RECV_TIMEOUT)
        .expect("the wait completed")
        .expect("wait --menu must succeed once the fixture's menu opens");
    assert_eq!(outcome["found"], Value::Bool(true));
    assert!(outcome["elapsed_ms"].is_number());

    fixture.dismiss_context_menu();
    assert!(fixture.wait_for_menu_state(false, STATE_TIMEOUT));
}

#[test]
fn wait_menu_closed_finds_the_already_open_menu_dismissed_mid_wait_through_the_command_layer() {
    bootstrap();
    let _app_name_scope = FIXTURE_APP_NAME_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let _stage = crate::tree::fixture::fixture_window::on_screen_stage();
    let fixture = MenuFixture::spawn().expect("the menu fixture starts");
    fixture.open_context_menu();
    assert!(fixture.wait_for_menu_state(true, STATE_TIMEOUT));
    thread::sleep(Duration::from_millis(250));

    let receiver = spawn_menu_wait(SurfaceWait::MenuClosed, own_image_name());

    thread::sleep(OPEN_AFTER);
    fixture.dismiss_context_menu();

    let outcome = receiver
        .recv_timeout(RECV_TIMEOUT)
        .expect("the wait completed")
        .expect("wait --menu-closed must succeed once the fixture dismisses its menu");
    assert_eq!(outcome["found"], Value::Bool(true));
    assert!(outcome["elapsed_ms"].is_number());
    assert!(fixture.wait_for_menu_state(false, STATE_TIMEOUT));
}
