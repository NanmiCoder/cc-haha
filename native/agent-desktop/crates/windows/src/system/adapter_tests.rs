use super::*;
use agent_desktop_core::InputOps;

#[test]
fn unknown_accessibility_is_unsupported_so_cli_and_ffi_agree() {
    use agent_desktop_core::PermissionState;

    const UNRECOGNIZED_UIA_HRESULT: i32 = 0x8000_4005_u32 as i32;

    let adapter = WindowsAdapter::new();
    assert!(adapter.unknown_accessibility_means_unsupported());

    assert_eq!(
        crate::system::permissions::map_uia_access(UNRECOGNIZED_UIA_HRESULT),
        PermissionState::Unknown
    );
}

#[test]
fn open_session_returns_a_live_session_instead_of_not_supported() {
    let affinity = SessionAffinity {
        session_id: Some("windows-com-session".into()),
    };

    let session = WindowsAdapter::new()
        .open_session(&affinity, Deadline::after(5_000).unwrap())
        .expect("windows must open an adapter session instead of failing closed");

    session.close().expect("a fresh session must close cleanly");
}

#[cfg(target_os = "windows")]
#[test]
fn permission_report_through_the_trait_probes_instead_of_defaulting() {
    use agent_desktop_core::PermissionState;

    let report =
        SystemOps::permission_report(&WindowsAdapter::new(), Deadline::after(5_000).unwrap())
            .unwrap();

    assert_eq!(report.automation, PermissionState::NotRequired);
    assert!(matches!(
        report.accessibility,
        PermissionState::Granted | PermissionState::Denied { .. }
    ));
}

#[cfg(target_os = "windows")]
#[test]
fn the_activation_path_acquires_a_windows_lease_and_settles() {
    crate::system::fixture::test_support::with_interaction_lease_test_lock(|| {
        let adapter = WindowsAdapter::new();
        let lease = SystemOps::acquire_interaction_lease(&adapter, Deadline::after(5_000).unwrap())
            .expect("the Windows lease override must not show up as not_supported");

        SystemOps::activate_renderer_accessibility(
            &adapter,
            ProcessIdentity::new(std::process::id(), "test"),
            &lease,
        )
        .expect("activation is the settle, which succeeds");
    });
}

/// Pins that `is_blocked_combo` is actually overridden here, reached
/// through the trait object exactly as core calls it: the default blocks
/// nothing, so an un-wired override would be indistinguishable from
/// "nothing is dangerous".
#[test]
fn is_blocked_combo_is_wired_to_the_windows_dangerous_list_through_the_trait() {
    use agent_desktop_core::{KeyCombo, Modifier, SystemOps as _};

    let adapter = WindowsAdapter::new();
    let dangerous = KeyCombo {
        key: "f4".into(),
        modifiers: vec![Modifier::Alt],
    };
    let harmless = KeyCombo {
        key: "c".into(),
        modifiers: vec![Modifier::Ctrl],
    };

    assert!(adapter.is_blocked_combo(&dangerous));
    assert!(!adapter.is_blocked_combo(&harmless));
}

/// Pins the `wait_for_menu` override itself: the trait default fails
/// closed with `PLATFORM_NOT_SUPPORTED`, so an un-wired override would be
/// indistinguishable from the method never having been implemented at
/// all. A nonexistent pid still reaches the adapter's own real classified
/// error rather than the trait default, which is exactly what
/// distinguishes "wired" from "not wired" here.
#[test]
fn wait_for_menu_reaches_the_windows_override_instead_of_the_not_supported_default() {
    use agent_desktop_core::{ErrorCode, ProcessIdentity};

    let adapter = WindowsAdapter::new();
    let process = ProcessIdentity::new(1u32, "windows-proc-v1:0:0");

    let error = SystemOps::wait_for_menu(&adapter, process, true, Deadline::after(1_000).unwrap())
        .expect_err("a bogus process identity must not report a satisfied wait");

    assert_ne!(error.code, ErrorCode::PlatformNotSupported);
}

/// Pins the `screenshot_window_frame` override itself: the trait default fails
/// closed with `PLATFORM_NOT_SUPPORTED`, so an un-wired override would be
/// indistinguishable from the method never having been implemented. A window
/// carrying no process-instance token is refused by the exact-window capture's
/// own first guard, which is what distinguishes "wired to `capture_window`"
/// from "still the trait default".
#[cfg(target_os = "windows")]
#[test]
fn screenshot_window_frame_is_wired_through_system_ops_to_the_exact_window_capture() {
    use agent_desktop_core::{ErrorCode, ProcessId, WindowState};

    let window = WindowInfo {
        id: "w-1".into(),
        title: String::new(),
        app: String::new(),
        pid: ProcessId::from(std::process::id()),
        process_instance: None,
        bounds: None,
        state: WindowState::default(),
    };

    let error = SystemOps::screenshot_window_frame(
        &WindowsAdapter::new(),
        &window,
        Deadline::after(1_000).unwrap(),
    )
    .expect_err("a tokenless window must be refused by the exact-window capture");

    assert_eq!(error.code, ErrorCode::InvalidArgs);
    assert_ne!(error.code, ErrorCode::PlatformNotSupported);
    assert!(
        error.message.contains("process instance token"),
        "refusal must come from the exact-window capture, got {}",
        error.message
    );
}

/// The surfaces gate: the adapter advertises exactly the surfaces it can
/// observe - a named window, the focused window, a Chromium modal
/// classified as a sheet, an open application menu, and the shell kinds
/// the kind table resolves on this build. Core validates the requested
/// surface against this list before the adapter is ever called, so this
/// advertisement is what makes `snapshot` end to end possible, and it is
/// the "advertised" side of the advertise/resolve/emit equality the live
/// tests pin.
#[test]
fn supported_surfaces_advertises_window_focused_sheet_menu_and_shell_kinds() {
    let adapter = WindowsAdapter::new();
    assert_eq!(
        adapter.supported_surfaces(),
        vec![
            SnapshotSurface::Window,
            SnapshotSurface::Focused,
            SnapshotSurface::Sheet,
            SnapshotSurface::Menu,
            SnapshotSurface::StartMenu,
            SnapshotSurface::Taskbar,
            SnapshotSurface::SystemTray,
            SnapshotSurface::SystemTrayOverflow,
            SnapshotSurface::ActionCenter,
        ]
    );
}

#[test]
fn renderer_activation_state_starts_unattempted_and_notes_once() {
    let adapter = WindowsAdapter::new();
    let process = ProcessIdentity::new(agent_desktop_core::ProcessId::new(1), "gen-1");

    assert!(!adapter.renderer_activation_attempted(&process));

    adapter.note_renderer_activation_attempted(process.clone());
    assert!(adapter.renderer_activation_attempted(&process));
}

/// Finding 2: a single global flag would let one process's settle
/// suppress another process's activation forever. The state must be
/// scoped so a second, unrelated process is unaffected by the first.
#[test]
fn renderer_activation_state_is_scoped_per_process_not_global() {
    let adapter = WindowsAdapter::new();
    let first = ProcessIdentity::new(agent_desktop_core::ProcessId::new(1), "gen-1");
    let second = ProcessIdentity::new(agent_desktop_core::ProcessId::new(2), "gen-1");

    adapter.note_renderer_activation_attempted(first.clone());

    assert!(adapter.renderer_activation_attempted(&first));
    assert!(!adapter.renderer_activation_attempted(&second));
}

/// `key_event` through the trait, exactly as FFI reaches it: a standalone
/// edge has no daemon to own the hold, so it must reject with zero
/// synthesis regardless of `down`'s value.
#[test]
fn key_event_rejects_a_standalone_edge_through_the_trait() {
    let adapter = WindowsAdapter::new();
    let deadline = Deadline::after(5_000).expect("bounded deadline");
    let lease = InteractionLease::guarded(deadline, ()).expect("lease");
    let combo = KeyCombo {
        key: "a".into(),
        modifiers: Vec::new(),
    };

    let error = InputOps::key_event(&adapter, &combo, true, &lease)
        .expect_err("a standalone key edge must reject");

    assert_eq!(
        error.code,
        agent_desktop_core::ErrorCode::ActionNotSupported
    );
    let details = error.details.expect("standalone error carries details");
    assert_eq!(details["raw_input_emitted"], false);
    assert_eq!(details["requires_daemon_owned_transaction"], true);
}
