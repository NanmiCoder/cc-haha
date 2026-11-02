use std::collections::HashMap;
use std::time::Duration;

use agent_desktop_core::{AdapterError, Deadline};
use zbus::Connection;
use zbus::zvariant::OwnedValue;

use crate::system::bus::bus_deadline::within;
use crate::system::bus::bus_slice::within_slice;
use crate::system::bus::session_bus::SessionBus;

const SERVICE: &str = "org.gnome.Mutter.DisplayConfig";
const PATH: &str = "/org/gnome/Mutter/DisplayConfig";
const INTERFACE: &str = "org.gnome.Mutter.DisplayConfig";
const LOGICAL_LAYOUT: u32 = 1;

/// The share of an X11 listing Mutter may take to supply scales.
pub(crate) const OPTIONAL_SLICE: Duration = Duration::from_millis(500);

/// One logical monitor as Mutter reports it. The reply carries position,
/// scale, the primary flag and the connectors driving it, but no size; the
/// size is derived from the driving monitor's current mode.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct LogicalMonitor {
    pub(crate) x: i32,
    pub(crate) y: i32,
    pub(crate) width: i32,
    pub(crate) height: i32,
    pub(crate) scale: f64,
    pub(crate) primary: bool,
    pub(crate) connectors: Vec<String>,
}

type Properties = HashMap<String, OwnedValue>;
type Spec = (String, String, String, String);
type Mode = (String, i32, i32, f64, f64, Vec<f64>, Properties);
type Physical = (Spec, Vec<Mode>, Properties);
type Logical = (i32, i32, f64, u32, bool, Vec<Spec>, Properties);
type Reply = (u32, Vec<Physical>, Vec<Logical>, Properties);

fn flag(properties: &Properties, key: &str) -> Option<bool> {
    properties
        .get(key)
        .and_then(|value| value.downcast_ref::<bool>().ok())
}

fn logical_layout(properties: &Properties) -> bool {
    properties
        .get("layout-mode")
        .and_then(|value| value.downcast_ref::<u32>().ok())
        == Some(LOGICAL_LAYOUT)
}

fn current_size(modes: &[Mode]) -> Option<(i32, i32)> {
    modes
        .iter()
        .find(|mode| flag(&mode.6, "is-current") == Some(true))
        .map(|mode| (mode.1, mode.2))
}

fn logical_size(monitors: &[Physical], specs: &[Spec], scale: f64, logical: bool) -> (i32, i32) {
    let size = specs.iter().find_map(|spec| {
        let monitor = monitors.iter().find(|monitor| monitor.0.0 == spec.0)?;
        current_size(&monitor.1)
    });
    match size {
        Some((width, height)) if logical && scale > 0.0 => (
            (f64::from(width) / scale).round() as i32,
            (f64::from(height) / scale).round() as i32,
        ),
        Some(size) => size,
        None => (0, 0),
    }
}

fn assemble(reply: Reply) -> Vec<LogicalMonitor> {
    let (_, monitors, logical, properties) = reply;
    let layout_is_logical = logical_layout(&properties);
    logical
        .into_iter()
        .map(|(x, y, scale, _, primary, specs, _)| {
            let (width, height) = logical_size(&monitors, &specs, scale, layout_is_logical);
            LogicalMonitor {
                x,
                y,
                width,
                height,
                scale,
                primary,
                connectors: specs.into_iter().map(|spec| spec.0).collect(),
            }
        })
        .collect()
}

async fn get_current_state(session: Connection) -> Option<Vec<LogicalMonitor>> {
    let reply = session
        .call_method(Some(SERVICE), PATH, Some(INTERFACE), "GetCurrentState", &())
        .await
        .ok()?;
    let body = reply.body().deserialize::<Reply>().ok()?;
    Some(assemble(body))
}

fn open_session(
    open_within: Deadline,
    deadline: Deadline,
) -> Result<Option<Connection>, AdapterError> {
    match SessionBus::get(open_within) {
        Ok(session) => Ok(Some(session)),
        Err(_) if !deadline.is_expired() => Ok(None),
        Err(error) => Err(error),
    }
}

/// The compositor's logical monitor list, or `None` when the session bus has
/// no Mutter answering it. Only the deadline itself is an error.
pub(crate) fn logical_monitors(
    deadline: Deadline,
) -> Result<Option<Vec<LogicalMonitor>>, AdapterError> {
    let Some(session) = open_session(deadline, deadline)? else {
        return Ok(None);
    };
    within(deadline, async { Ok(get_current_state(session).await) })
}

/// Like `logical_monitors`, but a Mutter that does not answer within `slice`
/// is reported as absent instead of spending the caller's budget.
pub(crate) fn logical_monitors_within(
    deadline: Deadline,
    slice: Duration,
) -> Result<Option<Vec<LogicalMonitor>>, AdapterError> {
    let Some(session) = open_session(deadline.capped(slice), deadline)? else {
        return Ok(None);
    };
    within(deadline, async {
        Ok(within_slice(slice, get_current_state(session))
            .await
            .flatten())
    })
}
