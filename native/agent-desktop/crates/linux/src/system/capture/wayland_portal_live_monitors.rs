use std::collections::HashMap;
use std::time::Duration;

use agent_desktop_core::{Deadline, ImageBuffer, ScreenshotTarget};
use zbus::blocking::Connection;
use zbus::zvariant::{OwnedValue, Value};

use super::wayland_portal::capture_wayland;
use super::wayland_portal_live_support::{Endpoint, PERMISSION_STORE, World, bus_call};

const DISPLAY_CONFIG: Endpoint = Endpoint {
    destination: "org.gnome.Mutter.DisplayConfig",
    path: "/org/gnome/Mutter/DisplayConfig",
    interface: "org.gnome.Mutter.DisplayConfig",
};
const TEMPORARY: u32 = 1;

type Properties = HashMap<String, OwnedValue>;
type Spec = (String, String, String, String);
type Mode = (String, i32, i32, f64, f64, Vec<f64>, Properties);
type Physical = (Spec, Vec<Mode>, Properties);
type Logical = (i32, i32, f64, u32, bool, Vec<Spec>, Properties);
type State = (u32, Vec<Physical>, Vec<Logical>, Properties);

type Placed = (String, String, HashMap<String, Value<'static>>);
type Config = (i32, i32, f64, u32, bool, Vec<Placed>);

/// Answers the portal's screenshot question ahead of time, as one earlier
/// Allow would, so a test that is about pixels never needs the dialog.
pub(super) fn allow_screenshots() {
    let connection = Connection::session().expect("the session bus");
    bus_call(
        &connection,
        &PERMISSION_STORE,
        "SetPermission",
        &("screenshot", true, "screenshot", "", vec!["yes"]),
    )
    .expect("the permission is stored");
}

fn state(connection: &Connection) -> State {
    bus_call(connection, &DISPLAY_CONFIG, "GetCurrentState", &())
        .expect("the monitor state")
        .body()
        .deserialize::<State>()
        .expect("a state")
}

/// Sets the scale of the first monitor with `ApplyMonitorsConfig` and lays
/// the monitors side by side in the layout's own units. The shell refuses a
/// scale its mode does not list, and refuses to change the layout mode.
pub(super) fn set_first_scale(scale: f64) -> Result<(), String> {
    let connection = Connection::session().map_err(|error| error.to_string())?;
    let current = state(&connection);
    let physical_layout = current
        .3
        .get("layout-mode")
        .and_then(|value| value.downcast_ref::<u32>().ok())
        == Some(2);
    let mut placed: Vec<Config> = Vec::new();
    let mut x = 0;
    for (index, logical) in current.2.iter().enumerate() {
        let connector = logical
            .5
            .first()
            .ok_or("a monitor with no connector")?
            .0
            .clone();
        let physical = current
            .1
            .iter()
            .find(|monitor| monitor.0.0 == connector)
            .ok_or("a connector with no monitor")?;
        let mode = physical
            .1
            .iter()
            .find(|mode| {
                mode.6
                    .get("is-current")
                    .and_then(|value| value.downcast_ref::<bool>().ok())
                    == Some(true)
            })
            .ok_or("a monitor with no current mode")?;
        let monitor_scale = if index == 0 { scale } else { logical.2 };
        placed.push((
            x,
            0,
            monitor_scale,
            0,
            logical.4,
            vec![(connector, mode.0.clone(), HashMap::new())],
        ));
        x += if physical_layout {
            mode.1
        } else {
            (f64::from(mode.1) / monitor_scale) as i32
        };
    }
    bus_call(
        &connection,
        &DISPLAY_CONFIG,
        "ApplyMonitorsConfig",
        &(
            current.0,
            TEMPORARY,
            placed,
            HashMap::<String, Value<'static>>::new(),
        ),
    )
    .map(|_| ())
    .ok_or_else(|| "the shell refused the configuration".to_owned())
}

pub(super) fn capture_target(
    _world: &World,
    target: &ScreenshotTarget,
) -> Result<ImageBuffer, agent_desktop_core::AdapterError> {
    std::thread::sleep(Duration::from_millis(300));
    capture_wayland(target, Deadline::after(60_000).expect("a deadline"))
}
