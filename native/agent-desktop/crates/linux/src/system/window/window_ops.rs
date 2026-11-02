use agent_desktop_core::{AdapterError, Deadline, DeliverySemantics, WindowFilter, WindowInfo};
use serde_json::json;

use super::window_order::front_to_back;
use super::window_position::place_windows;
use crate::system::SharedBus;
use crate::system::process::proc_scan::find_running;
use crate::system::process::proc_stat;
use crate::system::process::unresponsive::{require_known_target, settle_scoped, stopped_target};
use crate::system::registry::app_outcome::AppOutcome;
use crate::system::registry::app_query::AppQuery;
use crate::system::registry::listed_window::ListedWindow;
use crate::system::registry::registry_app::RegistryApp;
use crate::system::registry::registry_frames::RootRead;
use crate::system::registry::{Registry, read_registry_for, read_registry_query};
use crate::system::signal::signal_inventory::{Pass, read_selected, run_pass_with};
use crate::system::x11::stacking::client_stack;
use crate::system::x11::window::desktops::{self, Desktops};
use crate::system::x11::{self, DisplayReader, X11Source, X11State};

/// The windows of the applications `select` accepts, in registry order.
pub(crate) fn windows_of(
    bus: &SharedBus,
    registry: &Registry,
    select: impl Fn(&RegistryApp) -> bool,
    deadline: Deadline,
) -> Result<Vec<ListedWindow>, AdapterError> {
    read_selected(bus, registry, select, deadline).map(|(windows, _)| windows)
}

/// Places the windows of a pass, trims the client-side shadows the toolkit
/// drew, marks the minimized ones, those on another desktop and the focused
/// one, and returns the index of the focused window.
fn finish_listing(pass: &mut Pass, state: &X11State, desktops: Option<&Desktops>) -> Option<usize> {
    place_windows(&mut pass.windows, state, desktops);
    if let Some(index) = pass.focused {
        pass.windows[index].info.state.is_focused = true;
    }
    pass.focused
}

/// The windows of a pass that named its application, unless none were listed
/// because the application left a frame unanswered: an empty list would then
/// read as a closed window, so the caller is told the read ran out instead.
pub(crate) fn require_answered(
    windows: Vec<ListedWindow>,
    outcomes: &[AppOutcome],
    named: bool,
) -> Result<Vec<ListedWindow>, AdapterError> {
    let unanswered = outcomes
        .iter()
        .any(|outcome| outcome.read == RootRead::TimedOut);
    if named && windows.is_empty() && unanswered {
        return Err(AdapterError::timeout(
            "The application did not answer in time, so its windows could not be listed",
        )
        .with_details(json!({ "kind": "frames_unanswered" }))
        .with_disposition(DeliverySemantics::not_delivered()));
    }
    Ok(windows)
}

/// Lists top-level windows, marking the one the sources agree is focused.
pub(crate) fn list_windows(
    bus: &SharedBus,
    filter: &WindowFilter,
    deadline: Deadline,
) -> Result<Vec<WindowInfo>, AdapterError> {
    let pending = x11::start(|| DisplayReader.read());
    let desktops = x11::start(desktops::read);
    let stack = x11::start(client_stack::read);
    let select = |app: &RegistryApp| filter.app.as_deref().is_none_or(|query| app.matches(query));
    let registry = read_registry_query(
        bus,
        &AppQuery {
            pid: None,
            select: &select,
            enrich: true,
        },
        deadline,
    )?;
    let stopped = match filter.app.as_deref() {
        Some(query) => {
            require_known_target(&registry, select, query, find_running)?;
            stopped_target(&registry, select, proc_stat::is_stopped)
        }
        None => None,
    };
    let finish = |deadline| pending.finish(deadline).unwrap_or(X11State::Unavailable);
    let (mut pass, state) = run_pass_with(bus, &registry, select, finish, deadline)?;
    let windows = settle_scoped(pass.windows, stopped)?;
    pass.windows = require_answered(windows, &pass.outcomes, filter.app.is_some())?;
    finish_listing(
        &mut pass,
        &state,
        desktops.finish(deadline).flatten().as_ref(),
    );
    let mut windows = pass.windows;
    if filter.focused_only {
        windows.retain(|window| window.info.state.is_focused);
    }
    let stack = stack.finish(deadline).flatten();
    Ok(front_to_back(windows, &state, stack.as_deref())
        .into_iter()
        .map(|window| window.info)
        .collect())
}

/// The windows of one process, placed as `list_windows` places them. Only
/// that process is read, so an unrelated stopped application costs nothing.
pub(crate) fn windows_of_process(
    bus: &SharedBus,
    pid: u32,
    deadline: Deadline,
) -> Result<Vec<WindowInfo>, AdapterError> {
    let pending = x11::start(|| DisplayReader.read());
    let desktops = x11::start(desktops::read);
    let registry = read_registry_for(bus, Some(pid), deadline)?;
    let select = |app: &RegistryApp| app.root.pid() == pid;
    let finish = |deadline| pending.finish(deadline).unwrap_or(X11State::Unavailable);
    let (mut pass, state) = run_pass_with(bus, &registry, select, finish, deadline)?;
    finish_listing(
        &mut pass,
        &state,
        desktops.finish(deadline).flatten().as_ref(),
    );
    Ok(pass.windows.into_iter().map(|window| window.info).collect())
}

/// The focused window, or none when the available sources do not agree.
pub(crate) fn focused_window(
    bus: &SharedBus,
    deadline: Deadline,
) -> Result<Option<WindowInfo>, AdapterError> {
    let filter = WindowFilter {
        focused_only: true,
        app: None,
    };
    Ok(list_windows(bus, &filter, deadline)?.into_iter().next())
}

#[cfg(test)]
#[path = "window_ops_tests.rs"]
mod tests;
