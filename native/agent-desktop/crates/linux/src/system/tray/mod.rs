use agent_desktop_core::{AdapterError, Deadline, HitTestResult, NativeHandle, Point, RefEntry};

mod activate;
mod call;
mod capability;
mod execute;
mod identity;
mod introspect;
mod item;
mod live;
mod menu_event;
mod menu_layout;
mod menu_nodes;
mod menu_resolve;
mod node_evidence;
pub(crate) mod observe;
mod registration;
mod resolve;
mod tray_item;
pub(crate) mod view;
mod watcher;

#[cfg(test)]
mod fit_tests;
#[cfg(test)]
mod live_rig;
#[cfg(test)]
mod live_scripts;
#[cfg(test)]
mod live_tests;

#[cfg(test)]
pub(crate) use view::read;

pub(crate) use execute::execute;
pub(crate) use live::{
    actions as live_actions, bounds, element as live_element, state as live_state,
};
pub(crate) use resolve::resolve;
pub(crate) use watcher::require as require_watcher;

/// A tray item or one of its menu entries, named by D-Bus identity.
#[derive(Debug, Clone, PartialEq, Eq, zbus::export::serde::Deserialize)]
#[serde(crate = "zbus::export::serde", deny_unknown_fields)]
pub(crate) struct TrayTarget {
    pub(crate) owner: String,
    pub(crate) object_path: String,
    pub(crate) menu_path: Option<String>,
    pub(crate) entry_id: Option<i32>,
    pub(crate) label_path: Vec<String>,
}

pub(crate) fn target_of(handle: &NativeHandle) -> Option<&TrayTarget> {
    handle.downcast_ref::<TrayTarget>()
}

/// Whether a stored ref names a tray item or one of its menu entries.
pub(crate) fn owns(entry: &RefEntry) -> bool {
    entry
        .identity
        .native_id
        .as_ref()
        .is_some_and(|id| identity::is_tray_id(&id.value))
}

pub(crate) fn hit_test(
    target: &TrayTarget,
    _point: Point,
    deadline: Deadline,
) -> Result<HitTestResult, AdapterError> {
    live::element(target, deadline)?;
    Ok(HitTestResult::Unknown)
}
