use agent_desktop_core::{AdapterError, Deadline, DisplayInfo, ErrorCode, Rect};

use super::x11::{self, MonitorFault, MonitorReader, MonitorSource, X11Monitor};
use crate::system::display::display_cause::Cause;
use crate::system::display::display_mutter::LogicalMonitor;
use crate::system::display::display_server::{DisplayServer, session_server};
use crate::system::display::display_unavailable::Unavailable;

fn wayland_missing() -> AdapterError {
    AdapterError::new(
        ErrorCode::PlatformNotSupported,
        "Displays cannot be listed on this Wayland session",
    )
    .with_suggestion(
        "Run under GNOME, whose compositor answers the Mutter DisplayConfig \
         interface; no other Wayland display source is measured",
    )
}

pub(crate) fn unreachable(why: Unavailable) -> AdapterError {
    use crate::system::display::display_error::{DisplayCause, display_cause_error};
    let cause = match why.cause {
        Cause::NotConfigured => DisplayCause::NotConfigured,
        Cause::Missing => DisplayCause::Missing {
            address: why.detail,
        },
        Cause::Refused => DisplayCause::Refused { detail: why.detail },
    };
    display_cause_error(&cause)
}

fn unreadable() -> AdapterError {
    AdapterError::internal("The display server's monitor list could not be read")
        .with_suggestion("Retry once the X session answers")
}

/// The answer for a monitor read that failed or never finished: a refusal and
/// an address nobody answers at are permanent and say so, a read that ran out
/// of time is a timeout, and only a reply that could not be used is the
/// generic read failure.
pub(crate) fn fault_error(display: &str, fault: Option<MonitorFault>) -> AdapterError {
    match fault {
        Some(MonitorFault::Denied(reason)) => self::display_error::display_cause_error(
            &self::display_error::DisplayCause::AuthRefused { reason },
        ),
        Some(MonitorFault::Unreachable(detail)) => {
            use self::display_error::{DisplayCause, display_cause_error};
            let detail = format!("DISPLAY={display}: {detail}");
            let cause = if detail.to_ascii_lowercase().contains("connection refused") {
                DisplayCause::Refused { detail }
            } else {
                DisplayCause::Missing { address: detail }
            };
            display_cause_error(&cause)
        }
        Some(MonitorFault::Unreadable) => unreadable(),
        None => {
            self::display_error::display_cause_error(&self::display_error::DisplayCause::Silent)
        }
    }
}

fn scale_of(monitor: &X11Monitor, logical: &[LogicalMonitor]) -> f64 {
    logical
        .iter()
        .find(|candidate| {
            candidate.connectors.iter().any(|connector| {
                connector == &monitor.name || monitor.connectors.contains(connector)
            })
        })
        .map(|candidate| candidate.scale)
        .unwrap_or(1.0)
}

fn primaries_first(displays: &mut [DisplayInfo]) {
    displays.sort_by(|left, right| {
        right
            .is_primary
            .cmp(&left.is_primary)
            .then_with(|| left.id.cmp(&right.id))
    });
}

fn assemble(monitors: Vec<X11Monitor>, logical: &[LogicalMonitor]) -> Vec<DisplayInfo> {
    let mut displays: Vec<DisplayInfo> = monitors
        .into_iter()
        .map(|monitor| {
            let scale = scale_of(&monitor, logical);
            DisplayInfo {
                id: monitor.name,
                bounds: Rect::from(monitor.bounds),
                is_primary: monitor.primary,
                scale,
            }
        })
        .collect();
    if !displays.iter().any(|display| display.is_primary)
        && let Some(first) = displays.first_mut()
    {
        first.is_primary = true;
    }
    primaries_first(&mut displays);
    displays
}

fn from_mutter(logical: Vec<LogicalMonitor>) -> Vec<DisplayInfo> {
    let mut displays: Vec<DisplayInfo> = logical
        .into_iter()
        .map(|monitor| DisplayInfo {
            id: monitor.connectors.join("+"),
            bounds: Rect {
                x: f64::from(monitor.x),
                y: f64::from(monitor.y),
                width: f64::from(monitor.width),
                height: f64::from(monitor.height),
            },
            is_primary: monitor.primary,
            scale: monitor.scale,
        })
        .collect();
    primaries_first(&mut displays);
    displays
}

/// Decides the display answer from the measured inputs, pure over plain
/// records so every rule is testable without a session.
pub(crate) fn decide(
    server: DisplayServer,
    monitors: Option<Vec<X11Monitor>>,
    mutter: Option<Vec<LogicalMonitor>>,
) -> Result<Vec<DisplayInfo>, AdapterError> {
    match server {
        DisplayServer::Wayland => match mutter {
            Some(logical) => Ok(from_mutter(logical)),
            None => Err(wayland_missing()),
        },
        DisplayServer::X11(_) => match monitors {
            Some(list) => Ok(assemble(list, mutter.as_deref().unwrap_or_default())),
            None => Err(unreadable()),
        },
        DisplayServer::Unavailable(why) => Err(unreachable(why)),
    }
}

/// The X11 answer. Mutter only supplies scales there, so a Mutter that
/// failed or ran out of time leaves every scale at one, and the RandR
/// monitors are still reported.
pub(crate) fn decide_x11(
    server: DisplayServer,
    monitors: Result<Vec<X11Monitor>, AdapterError>,
    mutter: Result<Option<Vec<LogicalMonitor>>, AdapterError>,
) -> Result<Vec<DisplayInfo>, AdapterError> {
    decide(server, Some(monitors?), mutter.unwrap_or(None))
}

/// The displays of a Wayland session as Mutter lists them, with no look at the
/// environment: a caller that already chose the Wayland route asks here.
pub(crate) fn list_wayland_displays(deadline: Deadline) -> Result<Vec<DisplayInfo>, AdapterError> {
    decide(
        DisplayServer::Wayland,
        None,
        display_mutter::logical_monitors(deadline)?,
    )
}

/// Lists the session's displays. On X11 the monitor list comes from RandR
/// and Mutter's `DisplayConfig` supplies each monitor's scale where it
/// answers; on Wayland Mutter is the only measured source and a session
/// without it is `PLATFORM_NOT_SUPPORTED`.
pub(crate) fn list_displays(deadline: Deadline) -> Result<Vec<DisplayInfo>, AdapterError> {
    match session_server() {
        DisplayServer::Wayland => list_wayland_displays(deadline),
        DisplayServer::X11(display) => {
            let pending = x11::start(|| MonitorReader.read());
            let mutter =
                display_mutter::logical_monitors_within(deadline, display_mutter::OPTIONAL_SLICE);
            let monitors = match pending.finish(deadline) {
                Some(Ok(list)) => Ok(list),
                Some(Err(fault)) => Err(fault_error(&display, Some(fault))),
                None => Err(fault_error(&display, None)),
            };
            decide_x11(DisplayServer::X11(display), monitors, mutter)
        }
        server @ DisplayServer::Unavailable(_) => decide(server, None, None),
    }
}

#[cfg(test)]
#[path = "display_tests.rs"]
mod tests;

pub(crate) mod display_cause;
pub(crate) mod display_env;
pub(super) mod display_error;
#[cfg(test)]
pub(super) mod display_live_tests;
pub(super) mod display_mutter;
pub(super) mod display_probe;
pub(crate) mod display_reach;
pub(crate) mod display_server;
pub(crate) mod display_unavailable;
pub(crate) mod route;
