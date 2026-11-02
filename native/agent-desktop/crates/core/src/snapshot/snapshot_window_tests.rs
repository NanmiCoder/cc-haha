use super::*;
use crate::adapter::{ActionOps, InputOps, ObservationOps, SystemOps};

struct WindowAdapter {
    windows: Vec<WindowInfo>,
}

impl ObservationOps for WindowAdapter {
    fn list_windows(
        &self,
        _filter: &WindowFilter,
        _deadline: crate::Deadline,
    ) -> Result<Vec<WindowInfo>, crate::AdapterError> {
        Ok(self.windows.clone())
    }
}

impl ActionOps for WindowAdapter {}
impl InputOps for WindowAdapter {}
impl SystemOps for WindowAdapter {}

/// An adapter that implements the shell-surface seam with a caller-chosen
/// answer, so the routing decision in `resolve_window_for_surface` can be
/// observed without any platform involved.
struct ShellSurfaceAdapter {
    windows: Vec<WindowInfo>,
    resolution: Result<WindowInfo, crate::AdapterError>,
}

impl ObservationOps for ShellSurfaceAdapter {
    fn list_windows(
        &self,
        _filter: &WindowFilter,
        _deadline: crate::Deadline,
    ) -> Result<Vec<WindowInfo>, crate::AdapterError> {
        Ok(self.windows.clone())
    }

    fn resolve_shell_surface(
        &self,
        _surface: crate::SnapshotSurface,
        _deadline: crate::Deadline,
    ) -> Result<WindowInfo, crate::AdapterError> {
        self.resolution.clone()
    }
}

impl ActionOps for ShellSurfaceAdapter {}
impl InputOps for ShellSurfaceAdapter {}
impl SystemOps for ShellSurfaceAdapter {}

fn window(app: &str) -> WindowInfo {
    WindowInfo {
        id: "w-1".into(),
        title: "WhatsApp".into(),
        app: app.into(),
        pid: crate::ProcessId::new(10),
        process_instance: Some("instance-10".into()),
        bounds: None,
        state: Default::default(),
    }
}

fn shell_window() -> WindowInfo {
    WindowInfo {
        id: "w-shell".into(),
        title: "Action center".into(),
        app: "shell".into(),
        pid: crate::ProcessId::new(99),
        process_instance: None,
        bounds: None,
        state: Default::default(),
    }
}

#[test]
fn adapter_owned_app_resolution_preserves_bundle_identifier_matches() {
    let adapter = WindowAdapter {
        windows: vec![window("WhatsApp")],
    };

    let resolved = resolve_window(
        &adapter,
        Some("net.whatsapp.WhatsApp"),
        None,
        crate::Deadline::after(100).unwrap(),
    )
    .unwrap();

    assert_eq!(resolved.id, "w-1");
}

#[test]
fn running_application_without_a_window_is_not_reported_as_absent() {
    let adapter = WindowAdapter { windows: vec![] };

    let error = resolve_window(
        &adapter,
        Some("WhatsApp"),
        None,
        crate::Deadline::after(100).unwrap(),
    )
    .unwrap_err();

    assert_eq!(error.code(), "WINDOW_NOT_FOUND");
}

/// An adapter whose window inventory is always empty for the requested app,
/// and whose app inventory is caller-chosen, so the discrimination between
/// "never launched" and "running with no window" can be observed without any
/// platform involved.
struct AppInventoryAdapter {
    running_apps: Vec<crate::AppInfo>,
}

impl ObservationOps for AppInventoryAdapter {
    fn list_windows(
        &self,
        _filter: &WindowFilter,
        _deadline: crate::Deadline,
    ) -> Result<Vec<WindowInfo>, crate::AdapterError> {
        Ok(Vec::new())
    }

    fn list_apps(
        &self,
        _deadline: crate::Deadline,
    ) -> Result<Vec<crate::AppInfo>, crate::AdapterError> {
        Ok(self.running_apps.clone())
    }
}

impl ActionOps for AppInventoryAdapter {}
impl InputOps for AppInventoryAdapter {}
impl SystemOps for AppInventoryAdapter {}

fn running_app(name: &str) -> crate::AppInfo {
    crate::AppInfo {
        name: name.into(),
        pid: crate::ProcessId::new(7),
        bundle_id: None,
        process_instance: Some("generation-a".into()),
        presentation: None,
    }
}

/// A name that never matched any running process yields `APP_NOT_FOUND`, and
/// a name that matches a running but windowless process still yields
/// `WINDOW_NOT_FOUND` - both from the same code path, so neither can pass by
/// accident of the other's fix.
#[test]
fn app_name_resolution_discriminates_absent_from_windowless() {
    let adapter = AppInventoryAdapter {
        running_apps: vec![running_app("ApplicationFrameHost.exe")],
    };

    let absent = resolve_window(
        &adapter,
        Some("NoSuchApp.exe"),
        None,
        crate::Deadline::after(100).unwrap(),
    )
    .unwrap_err();
    assert_eq!(absent.code(), "APP_NOT_FOUND");

    let windowless = resolve_window(
        &adapter,
        Some("ApplicationFrameHost.exe"),
        None,
        crate::Deadline::after(100).unwrap(),
    )
    .unwrap_err();
    assert_eq!(windowless.code(), "WINDOW_NOT_FOUND");
}

/// An adapter whose `resolve_shell_surface` answers with the trait default -
/// the exact shape `AdapterError::not_supported` builds - falls through to
/// the application path for a routed shell kind, so upgrading an adapter in
/// two steps (advertise, then implement) never changes its behavior.
#[test]
fn a_shell_kind_falls_through_to_the_application_path_on_the_trait_default() {
    let adapter = ShellSurfaceAdapter {
        windows: vec![window("WhatsApp")],
        resolution: Err(crate::AdapterError::not_supported("resolve_shell_surface")),
    };

    let resolved = resolve_window_for_surface(
        &adapter,
        Some("WhatsApp"),
        None,
        crate::SnapshotSurface::ActionCenter,
        crate::Deadline::after(100).unwrap(),
    )
    .unwrap();

    assert_eq!(resolved.id, "w-1");
}

/// The same fall-through, proven by the error an adapter without the seam
/// has always produced: the application path's own surface-naming
/// `WINDOW_NOT_FOUND`, not the seam's answer.
#[test]
fn an_adapter_without_the_seam_resolves_shell_kinds_exactly_as_before() {
    let adapter = WindowAdapter { windows: vec![] };

    let error = resolve_window_for_surface(
        &adapter,
        None,
        None,
        crate::SnapshotSurface::ActionCenter,
        crate::Deadline::after(100).unwrap(),
    )
    .unwrap_err();

    assert_eq!(error.code(), "WINDOW_NOT_FOUND");
    let AppError::Adapter(adapter_error) = error else {
        panic!("expected an adapter error");
    };
    assert!(
        adapter_error
            .message
            .contains(crate::SnapshotSurface::ActionCenter.as_str()),
        "the unchanged application-path error names the surface: {}",
        adapter_error.message
    );
}

/// A routed shell kind consults the seam ahead of the application path: the
/// adapter's resolution wins even when the window inventory is empty and the
/// application path would have failed.
#[test]
fn a_shell_kind_is_routed_to_the_seam_when_the_adapter_implements_it() {
    let adapter = ShellSurfaceAdapter {
        windows: vec![],
        resolution: Ok(shell_window()),
    };

    let resolved = resolve_window_for_surface(
        &adapter,
        None,
        None,
        crate::SnapshotSurface::ActionCenter,
        crate::Deadline::after(100).unwrap(),
    )
    .unwrap();

    assert_eq!(resolved.id, "w-shell");
}

/// The seam's non-default answers pass through untouched: a `WINDOW_NOT_FOUND`
/// for a closed surface reaches the caller as the adapter supplied it, with
/// its suggestion intact.
#[test]
fn the_seams_window_not_found_passes_through_with_its_suggestion() {
    let adapter = ShellSurfaceAdapter {
        windows: vec![window("WhatsApp")],
        resolution: Err(crate::AdapterError::new(
            crate::ErrorCode::WindowNotFound,
            "The 'action-center' shell surface is not open on this desktop",
        )
        .with_suggestion(
            "Run 'open-system-surface --surface action-center' to raise it, then retry",
        )),
    };

    let error = resolve_window_for_surface(
        &adapter,
        Some("WhatsApp"),
        None,
        crate::SnapshotSurface::ActionCenter,
        crate::Deadline::after(100).unwrap(),
    )
    .unwrap_err();

    let AppError::Adapter(adapter_error) = error else {
        panic!("expected an adapter error");
    };
    assert_eq!(adapter_error.code, crate::ErrorCode::WindowNotFound);
    assert!(
        adapter_error
            .suggestion
            .as_deref()
            .is_some_and(|s| s.contains("open-system-surface")),
        "the adapter's own suggestion must survive the pass-through"
    );
}

/// A window-owned sub-surface is never routed to the seam, even when the
/// adapter implements it: the application path stays the answer for kinds
/// some application owns.
#[test]
fn a_window_owned_surface_kind_is_not_routed_to_the_seam() {
    let adapter = ShellSurfaceAdapter {
        windows: vec![window("WhatsApp")],
        resolution: Ok(shell_window()),
    };

    let resolved = resolve_window_for_surface(
        &adapter,
        Some("WhatsApp"),
        None,
        crate::SnapshotSurface::Sheet,
        crate::Deadline::after(100).unwrap(),
    )
    .unwrap();

    assert_eq!(resolved.id, "w-1");
}
