use std::time::Duration;

use agent_desktop_core::Deadline;
use zbus::connection::Builder;
use zbus::zvariant::OwnedValue;

use crate::system::bus::bus_deadline::within;
use crate::system::bus::bus_slice::within_slice;

const SERVICE: &str = "org.gnome.Shell";
const PATH: &str = "/org/gnome/Shell";
const PROPERTIES: &str = "org.freedesktop.DBus.Properties";
const READ_BUDGET: Duration = Duration::from_millis(500);

async fn overview_active() -> Option<bool> {
    let session = Builder::session().ok()?.build().await.ok()?;
    let reply = session
        .call_method(
            Some(SERVICE),
            PATH,
            Some(PROPERTIES),
            "Get",
            &(SERVICE, "OverviewActive"),
        )
        .await
        .ok()?;
    let value = reply.body().deserialize::<OwnedValue>().ok()?;
    value.downcast_ref::<bool>().ok()
}

/// Whether GNOME Shell reports its Activities Overview open. `None` is a
/// session with no GNOME Shell on its bus, or one that did not answer in time.
/// The property is only read: it is writable, and writing it would change the
/// user's shell.
pub(crate) fn overview_open() -> Option<bool> {
    let deadline = Deadline::from_duration(READ_BUDGET).ok()?;
    within(deadline, async {
        Ok(within_slice(READ_BUDGET, overview_active()).await.flatten())
    })
    .ok()
    .flatten()
}
