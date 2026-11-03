use std::time::Duration;

use agent_desktop_core::{
    AdapterError, Deadline, ErrorCode, InteractionLease, InteractionPolicy, MouseButton, Rect,
    WindowInfo, WindowState,
};
use serde_json::json;

use super::container::{Landmark, locate_anchor};
use super::identity::{ShellRoot, find_root};
use super::kinds::{ShellKind, title_of};
use crate::input::deliver::ensure_headed_click_policy;
use crate::input::physical::target_pointer::click_shell;
use crate::system::shell::anchor::Anchor;
use crate::system::shell::located::Located;
use crate::system::{SharedBus, process::process_facts, window::window_id};

const POLL: Duration = Duration::from_millis(40);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Opened {
    Adopted,
    Opened,
}

fn opener_of(kind: ShellKind) -> Option<Anchor> {
    match kind {
        ShellKind::MessageList => Some(Anchor::Landmark(Landmark::DateMenu)),
        ShellKind::SystemMenu => Some(Anchor::SystemButton),
        ShellKind::Dock | ShellKind::Tray => None,
    }
}

pub(super) fn container_landmark(kind: ShellKind) -> Landmark {
    match kind {
        ShellKind::Dock => Landmark::DockPanel,
        ShellKind::Tray => Landmark::TrayPanel,
        ShellKind::MessageList => Landmark::MessageList,
        ShellKind::SystemMenu => Landmark::SystemMenu,
    }
}

/// What opening a surface needs from the shell, so the rules
/// run against a fixed shell in a test.
pub(crate) trait Surface {
    fn backed(&self, kind: ShellKind, deadline: Deadline) -> Result<(), AdapterError>;
    fn showing(&self, kind: ShellKind, deadline: Deadline) -> Result<bool, AdapterError>;
    fn press_opener(&self, kind: ShellKind, policy: InteractionPolicy) -> Result<(), AdapterError>;
    fn window(&self, kind: ShellKind, deadline: Deadline) -> Result<WindowInfo, AdapterError>;
    fn pause(&self, duration: Duration);
}

fn settle<W: Surface>(
    world: &W,
    kind: ShellKind,
    wanted: bool,
    deadline: Deadline,
) -> Result<(), AdapterError> {
    loop {
        if world.showing(kind, deadline)? == wanted {
            return Ok(());
        }
        if deadline.is_expired() {
            let label = if wanted { "visible" } else { "hidden" };
            return Err(AdapterError::new(
                ErrorCode::Timeout,
                format!(
                    "The shell's {} did not become {label} in time",
                    title_of(kind)
                ),
            )
            .with_suggestion("Retry the command; the shell may be busy")
            .with_details(
                json!({ "physical_delivery_started": true, "surface": title_of(kind) }),
            ));
        }
        world.pause(POLL);
    }
}

pub(crate) fn open_with<W: Surface>(
    world: &W,
    kind: ShellKind,
    policy: InteractionPolicy,
    deadline: Deadline,
) -> Result<(WindowInfo, Opened), AdapterError> {
    world
        .backed(kind, deadline)
        .map_err(|error| with_open_progress(error, false))?;
    if opener_of(kind).is_none()
        || world
            .showing(kind, deadline)
            .map_err(|error| with_open_progress(error, false))?
    {
        return world
            .window(kind, deadline)
            .map(|window| (window, Opened::Adopted))
            .map_err(|error| with_open_progress(error, false));
    }
    ensure_headed_click_policy(policy).map_err(|error| with_open_progress(error, false))?;
    world.press_opener(kind, policy).map_err(|error| {
        let started = error
            .details
            .as_ref()
            .and_then(|details| details.get("physical_delivery_started"))
            .and_then(serde_json::Value::as_bool)
            == Some(true);
        with_open_progress(error, started)
    })?;
    settle(world, kind, true, deadline).map_err(|error| with_open_progress(error, true))?;
    world
        .window(kind, deadline)
        .map(|window| (window, Opened::Opened))
        .map_err(|error| with_open_progress(error, true))
}

pub(crate) fn close_with<W: Surface>(
    world: &W,
    kind: ShellKind,
    deadline: Deadline,
) -> Result<(), AdapterError> {
    if opener_of(kind).is_none() || !world.showing(kind, deadline)? {
        return Ok(());
    }
    world.press_opener(kind, InteractionPolicy::headed())?;
    settle(world, kind, false, deadline)
}

fn with_open_progress(error: AdapterError, opened_by_call: bool) -> AdapterError {
    let mut details = match error.details.clone() {
        Some(serde_json::Value::Object(map)) => map,
        Some(details) => {
            let mut map = serde_json::Map::new();
            map.insert("cause".to_owned(), details);
            map
        }
        None => serde_json::Map::new(),
    };
    details.insert("surface_opened_by_call".to_owned(), json!(opened_by_call));
    error.with_details(serde_json::Value::Object(details))
}

pub(crate) fn window_info(
    kind: ShellKind,
    root: &ShellRoot,
    located: &Located,
) -> Result<WindowInfo, AdapterError> {
    if !showing_of(kind, located) {
        return Err(AdapterError::new(
            ErrorCode::WindowNotFound,
            format!("The shell's {} surface is closed", title_of(kind)),
        )
        .with_suggestion("Run 'open-system-surface' for this surface before observing it"));
    }
    let container = &located.container;
    let id = window_id::encode(container.element.bus_name(), container.element.path())
        .ok_or_else(|| AdapterError::internal("The shell container has no window id"))?;
    Ok(WindowInfo {
        id,
        title: title_of(kind).to_owned(),
        app: super::identity::SHELL_BUS_NAME.to_owned(),
        pid: root.pid.into(),
        process_instance: process_facts::read(root.pid).map(|facts| facts.instance),
        bounds: container.placed().map(Rect::from),
        state: WindowState {
            is_focused: false,
            accessible: true,
            minimized: Some(false),
            visible: Some(true),
        },
    })
}

struct LiveSurface<'a> {
    bus: &'a SharedBus,
    lease: &'a InteractionLease,
}

impl LiveSurface<'_> {
    fn located(
        &self,
        anchor: Anchor,
        deadline: Deadline,
    ) -> Result<(ShellRoot, Located), AdapterError> {
        let root = find_root(self.bus, deadline)?;
        let located = locate_anchor(self.bus, &root, anchor, deadline)?;
        Ok((root, located))
    }
}

impl Surface for LiveSurface<'_> {
    fn backed(&self, kind: ShellKind, deadline: Deadline) -> Result<(), AdapterError> {
        match kind {
            ShellKind::Tray => crate::system::tray::require_watcher(deadline),
            ShellKind::Dock | ShellKind::MessageList | ShellKind::SystemMenu => Ok(()),
        }
    }

    fn showing(&self, kind: ShellKind, deadline: Deadline) -> Result<bool, AdapterError> {
        is_showing(self.bus, kind, deadline)
    }

    fn press_opener(&self, kind: ShellKind, policy: InteractionPolicy) -> Result<(), AdapterError> {
        let Some(opener) = opener_of(kind) else {
            return Ok(());
        };
        let (_, located) = self.located(opener, self.lease.deadline())?;
        click_shell(
            self.bus,
            &located.anchor.element,
            MouseButton::Left,
            policy,
            self.lease,
        )
        .map(|_| ())
    }

    fn window(&self, kind: ShellKind, deadline: Deadline) -> Result<WindowInfo, AdapterError> {
        let anchor = Anchor::Landmark(container_landmark(kind));
        let (root, located) = self.located(anchor, deadline)?;
        window_info(kind, &root, &located)
    }

    fn pause(&self, duration: Duration) {
        std::thread::sleep(duration);
    }
}

pub(crate) fn open(
    bus: &SharedBus,
    kind: ShellKind,
    policy: InteractionPolicy,
    lease: &InteractionLease,
) -> Result<(WindowInfo, Opened), AdapterError> {
    open_with(&LiveSurface { bus, lease }, kind, policy, lease.deadline())
}

pub(crate) fn close(
    bus: &SharedBus,
    kind: ShellKind,
    lease: &InteractionLease,
) -> Result<(), AdapterError> {
    close_with(&LiveSurface { bus, lease }, kind, lease.deadline())
}

pub(crate) fn is_showing(
    bus: &SharedBus,
    kind: ShellKind,
    deadline: Deadline,
) -> Result<bool, AdapterError> {
    let anchor = Anchor::Landmark(container_landmark(kind));
    let root = find_root(bus, deadline)?;
    let located = locate_anchor(bus, &root, anchor, deadline)?;
    Ok(showing_of(kind, &located))
}

/// Visibility belongs to the structurally identified container.
pub(super) fn showing_of(
    kind: ShellKind,
    located: &crate::system::shell::located::Located,
) -> bool {
    match kind {
        ShellKind::MessageList => located.container.showing,
        ShellKind::SystemMenu => located.anchor.showing,
        ShellKind::Dock | ShellKind::Tray => true,
    }
}

#[cfg(test)]
#[path = "open_tests.rs"]
mod tests;
