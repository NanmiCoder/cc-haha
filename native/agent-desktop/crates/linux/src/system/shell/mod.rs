pub(crate) mod anchor;
pub(crate) mod call_failure;
pub(crate) mod located;
use agent_desktop_core::{
    AdapterError, Deadline, ErrorCode, InteractionLease, InteractionPolicy, ObservationRequest,
    ObservationRoot, ObservedTree, SnapshotSurface, WindowInfo,
};

use crate::system::{SharedBus, window::window_id};
use crate::tree::AtspiElement;

pub(crate) mod container;
pub(crate) mod deliver;
pub(crate) mod detect;
pub(crate) mod hit;
pub(crate) mod identity;
pub(crate) mod kinds;
pub(crate) mod light;
pub(crate) mod live_state;
pub(crate) mod open;
mod registry;
pub(crate) mod search;
mod tray_tree;
pub(crate) mod window_gate;

#[cfg(test)]
mod fake_tree;
#[cfg(test)]
mod live_wayland_tests;
#[cfg(test)]
mod outage_live_tests;
#[cfg(test)]
mod owner_live_tests;

const SUPPORT_BUDGET_MS: u64 = 3_000;

/// The shell kinds this session can present, as snapshot surfaces.
pub(crate) fn supported(bus: &SharedBus) -> Vec<SnapshotSurface> {
    let Ok(deadline) = Deadline::after(SUPPORT_BUDGET_MS) else {
        return Vec::new();
    };
    kinds::advertised(&detect::detect(bus, deadline))
        .into_iter()
        .filter(|surface| resolve_surface(bus, *surface, deadline).is_ok())
        .collect()
}

/// The answer for a gnome-shell process that this session's accessibility
/// registry does not list: it belongs to another session, so it is not this
/// session's shell.
pub(crate) fn not_this_sessions_shell() -> AdapterError {
    identity::tree_absent("the shell process is not on this session's accessibility bus")
}

pub(crate) fn is_shell_process(pid: u32) -> bool {
    identity::is_shell_process(pid)
}

/// Whether the element belongs to the desktop shell rather than to an application.
pub(crate) fn is_shell_element(element: &AtspiElement) -> bool {
    identity::is_shell_owner(element.bus_name(), element.pid())
}

/// Whether the window is a shell content window.
pub(crate) fn is_shell_window(window: &WindowInfo) -> bool {
    window_id::decode(&window.id)
        .is_ok_and(|(bus_name, _)| identity::is_shell_owner(&bus_name, window.pid.get()))
}

pub(crate) fn resolve_surface(
    bus: &SharedBus,
    surface: SnapshotSurface,
    deadline: Deadline,
) -> Result<WindowInfo, AdapterError> {
    let Some(kind) = kinds::kind_of(surface) else {
        return Err(AdapterError::not_supported("resolve_shell_surface"));
    };
    let root = identity::find_root(bus, deadline)?;
    let landmark = open::container_landmark(kind);
    let located = container::locate_anchor(
        bus,
        &root,
        crate::system::shell::anchor::Anchor::Landmark(landmark),
        deadline,
    )?;
    open::window_info(kind, &root, &located)
}

pub(crate) fn open_surface(
    bus: &SharedBus,
    surface: SnapshotSurface,
    policy: InteractionPolicy,
    lease: &InteractionLease,
) -> Result<WindowInfo, AdapterError> {
    let Some(kind) = kinds::kind_of(surface) else {
        return Err(AdapterError::not_supported("open_system_surface"));
    };
    if kind == kinds::ShellKind::Dock {
        return Err(AdapterError::new(
            ErrorCode::PlatformNotSupported,
            "The taskbar surface is not offered: no stock shell shows a dock",
        )
        .with_suggestion("Open system-tray, action-center or quick-settings instead"));
    }
    open::open(bus, kind, policy, lease).map(|(window, _)| window)
}

pub(crate) fn observe_shell(
    bus: &SharedBus,
    window: &WindowInfo,
    request: &ObservationRequest,
) -> Result<ObservedTree, AdapterError> {
    window_gate::verify(bus, &window.id, request.deadline)?;
    let current = resolve_surface(bus, request.surface, request.deadline)?;
    if current.id != window.id {
        return Err(AdapterError::new(
            ErrorCode::WindowNotFound,
            "The shell surface changed before it could be observed",
        ));
    }
    let mut inner = *request;
    inner.surface = SnapshotSurface::Window;
    let root = ObservationRoot::Window(window);
    if kinds::kind_of(request.surface) == Some(kinds::ShellKind::Tray) {
        let view = crate::system::tray::view::read(request.deadline)?;
        return tray_tree::logical_tree(&view, window, request.surface);
    }
    crate::tree::observe_tree(bus, root, &inner)
}
