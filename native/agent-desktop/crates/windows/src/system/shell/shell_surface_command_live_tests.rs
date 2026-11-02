//! Windows-only: drives `agent_desktop_core::commands::open_system_surface`
//! end to end - through the real adapter, the real kind table, the real
//! interaction lease - and proves the open-to-observation round trip with the crate's own
//! command functions: the window identity the open returns is the identity
//! the observation stack consumes, with no second lookup in between.
//!
//! The consumer leg runs the `snapshot` command with `--surface <kind>`
//! rather than `--window <id>`. On this platform that is the same fact, not
//! a weaker one: the agent-window inventory deliberately excludes the shell
//! chrome (the taskbar fails the tool-window filter, A26-1 measured the
//! immersive family absent from `EnumWindows` entirely), which is exactly
//! why the shell-surface resolution seam exists. The snapshot therefore
//! reaches the surface only through the shell-surface seam, and asserting
//! the id it consumed equals the id the open returned is the round trip.
//!
//! Every test holds `test_support::SHELL_SURFACE_LOCK` - the surfaces are
//! machine-global - and, because the command takes the real cross-process
//! interaction lease, `with_interaction_lease_test_lock` for its body. The
//! shell lock is taken first; no lease test ever takes the shell lock, so
//! the ordering cannot cycle.

#![cfg(target_os = "windows")]

use agent_desktop_core::commands::open_system_surface::{self, OpenSystemSurfaceArgs};
use agent_desktop_core::commands::snapshot::{self, SnapshotArgs};
use agent_desktop_core::{AdapterError, AppError, CommandContext, SnapshotSurface};

use crate::adapter::WindowsAdapter;
use crate::system::capture::capture_test_support::HomeIsolation;
use crate::system::fixture::test_support::{
    SHELL_SURFACE_LOCK, or_skip_shell, wait_for_foreground_to_settle,
    with_interaction_lease_test_lock,
};
use crate::system::fixture::test_time::deadline;
use crate::system::private_file::WindowsPrivateFile;
use crate::system::shell::raise_oracle::{responded_since, witness_desktop};
use crate::system::shell::shell_surface_open::close_surface;
use crate::tree::fixture::bootstrap;

fn foreground() -> isize {
    use windows_sys::Win32::UI::WindowsAndMessaging::GetForegroundWindow;
    (unsafe { GetForegroundWindow() }) as isize
}

/// Finally-style cleanup: whatever the test raised is dismissed when the
/// test body exits, on any path, so a failed assertion never leaks a raised
/// surface into the next test.
struct CloseOnDrop(SnapshotSurface);

impl Drop for CloseOnDrop {
    fn drop(&mut self) {
        let _ = close_surface(self.0, deadline(8_000));
    }
}

/// The command layer wraps the adapter's answer in `AppError`; the skip
/// classification reads the adapter error that produced it.
fn adapter_error_of(error: AppError) -> AdapterError {
    match error {
        AppError::Adapter(error) => error,
        error => AdapterError::internal(error.to_string()),
    }
}

fn open_command(kind: SnapshotSurface, context: &CommandContext) -> Option<serde_json::Value> {
    let witness = witness_desktop();
    let adapter = WindowsAdapter::new();
    or_skip_shell(
        &format!("the command opens the {}", kind.as_str()),
        open_system_surface::execute(OpenSystemSurfaceArgs { surface: kind }, &adapter, context)
            .map_err(adapter_error_of),
        || responded_since(&witness),
    )
}

fn snapshot_command(kind: SnapshotSurface) -> serde_json::Value {
    let adapter = WindowsAdapter::new();
    let context = CommandContext::default();
    snapshot::execute(
        SnapshotArgs {
            app: None,
            window_id: None,
            max_depth: 4,
            include_bounds: false,
            interactive_only: false,
            compact: true,
            surface: kind,
            skeleton: false,
            root_ref: None,
            timeout_ms: Some(10_000),
            force_electron_a11y: false,
        },
        &adapter,
        &context,
    )
    .expect("the snapshot consumes the open surface's identity")
}

fn assert_round_trip(kind: SnapshotSurface) -> Option<()> {
    let _home = HomeIsolation::enter("agent-desktop-surface-command-home");
    let _ = agent_desktop_core::install_private_file_ops(Box::new(WindowsPrivateFile::new()));
    let context = CommandContext::default().with_headed(true);
    let opened = open_command(kind, &context)?;

    assert_eq!(
        opened["surface"],
        kind.as_str(),
        "the envelope names the kind in its snake_case JSON spelling"
    );
    let window_id = opened["window"]["id"]
        .as_str()
        .expect("the envelope carries the window identity")
        .to_owned();
    assert!(
        opened["window"]["pid"].is_number() && opened["window"]["app_name"].is_string(),
        "the window object is the full WindowInfo shape, not an id bare: {opened}"
    );

    let snap = snapshot_command(kind);
    assert_eq!(
        snap["window"]["id"], window_id,
        "the observation consumed the identity the open returned, with no second lookup"
    );
    Some(())
}

/// The exit-criterion kinds, one test each: opening returns a window object
/// whose identity the observation stack consumes in the same test.
#[test]
fn opening_the_action_center_round_trips_into_the_snapshot() {
    bootstrap();
    let _lock = SHELL_SURFACE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    with_interaction_lease_test_lock(|| {
        let _ = close_surface(SnapshotSurface::ActionCenter, deadline(5_000));
        let _cleanup = CloseOnDrop(SnapshotSurface::ActionCenter);

        let Some(()) = assert_round_trip(SnapshotSurface::ActionCenter) else {
            return;
        };
    });
}

#[test]
fn opening_the_start_menu_round_trips_into_the_snapshot() {
    bootstrap();
    let _lock = SHELL_SURFACE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    with_interaction_lease_test_lock(|| {
        let _ = close_surface(SnapshotSurface::StartMenu, deadline(5_000));
        let _cleanup = CloseOnDrop(SnapshotSurface::StartMenu);

        if assert_round_trip(SnapshotSurface::StartMenu).is_none() {
            eprintln!(
                "skip start-menu round trip: this desktop's shell declined to present the surface"
            );
        }
    });
}

#[test]
fn opening_the_taskbar_round_trips_without_raising_anything() {
    bootstrap();
    let _lock = SHELL_SURFACE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    with_interaction_lease_test_lock(|| {
        let _home = HomeIsolation::enter("agent-desktop-surface-command-home");
        let _ = agent_desktop_core::install_private_file_ops(Box::new(WindowsPrivateFile::new()));
        assert!(
            wait_for_foreground_to_settle(),
            "the desktop's foreground must settle before the no-raise open"
        );
        let before = foreground();

        let context = CommandContext::default().with_headed(true);
        let opened = open_command(SnapshotSurface::Taskbar, &context)
            .expect("the taskbar is always up, so its open must never be declined");

        let window_id = opened["window"]["id"]
            .as_str()
            .expect("the envelope carries the window identity")
            .to_owned();

        let after = foreground();
        let raised = crate::system::window::window_ops::parse_handle(&window_id) as isize;
        assert!(
            !(before != raised && after == raised),
            "the taskbar is already up, so its open must not pull the foreground onto \
             it: the foreground was {before} before the open and {after} after, and \
             {raised} is the surface the open returned"
        );
        if after != before {
            eprintln!(
                "note: the foreground moved from {before} to {after} during the open, \
                 and {raised} is the surface it returned. The open did not pull the \
                 foreground onto its own surface, which is what this case asserts; on a \
                 shared machine another process can take the foreground at any moment, \
                 and asserting that nothing did would make this test hostage to the \
                 machine rather than to the command."
            );
        }

        let snap = snapshot_command(SnapshotSurface::Taskbar);
        assert_eq!(snap["window"]["id"], window_id);
    });
}

/// A strict-headless caller is refused by the command itself - the adapter's
/// focus-steal floor fires before the surface is raised, so the foreground
/// never moves and nothing is presented.
#[test]
fn strict_headless_open_refuses_before_raising() {
    bootstrap();
    let _lock = SHELL_SURFACE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    with_interaction_lease_test_lock(|| {
        let _ = close_surface(SnapshotSurface::ActionCenter, deadline(5_000));
        assert!(
            wait_for_foreground_to_settle(),
            "the desktop's foreground must settle before the refusal is staged"
        );
        let before = foreground();

        let adapter = WindowsAdapter::new();
        let error = open_system_surface::execute(
            OpenSystemSurfaceArgs {
                surface: SnapshotSurface::ActionCenter,
            },
            &adapter,
            &CommandContext::default(),
        )
        .expect_err("a strict-headless caller is refused");

        assert_eq!(error.code(), "POLICY_DENIED");
        assert_eq!(
            foreground(),
            before,
            "a refusal that moved the foreground is not a refusal"
        );
        let resolved = crate::system::shell::shell_surface::resolve_surface(
            SnapshotSurface::ActionCenter,
            deadline(5_000),
        )
        .expect("the desktop is readable")
        .is_some();
        assert!(
            !resolved,
            "the refused open must not have raised the surface"
        );
    });
}
