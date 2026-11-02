use std::collections::HashMap;

use agent_desktop_core::{AdapterError, Deadline, ErrorCode};
use futures_util::StreamExt;
use zbus::zvariant::{OwnedValue, Value};
use zbus::{Connection, Proxy};

use super::wayland_portal_call::{PORTAL_SERVICE, Pending, PortalAnswer, PortalWire};
use crate::system::bus::bus_deadline::within;
use crate::system::bus::session_bus::SessionBus;

const DESKTOP_PATH: &str = "/org/freedesktop/portal/desktop";
const SCREENSHOT: &str = "org.freedesktop.portal.Screenshot";
const CLOSE_GRACE_MS: u64 = 1_000;
const REQUEST: &str = "org.freedesktop.portal.Request";

/// The one real binding of the portal calls: the desktop session bus, the
/// bus the portal service lives on, never the accessibility bus.
struct BusWire {
    connection: Connection,
}

struct Waiting {
    connection: Connection,
    path: String,
    stream: zbus::proxy::SignalStream<'static>,
}

fn portal_error(error: &zbus::Error) -> AdapterError {
    let missing = matches!(
        error,
        zbus::Error::MethodError(name, _, _)
            if name.as_str() == "org.freedesktop.DBus.Error.ServiceUnknown"
                || name.as_str() == "org.freedesktop.DBus.Error.NameHasNoOwner"
    );
    if missing {
        return AdapterError::new(
            ErrorCode::PlatformNotSupported,
            "The desktop portal service is not running in this session",
        )
        .with_suggestion("Install and start xdg-desktop-portal and its backend for this desktop");
    }
    AdapterError::new(ErrorCode::ActionFailed, "The desktop portal call failed")
        .with_platform_detail(error.to_string())
}

fn close_grace() -> Result<Deadline, AdapterError> {
    Deadline::detached_after(CLOSE_GRACE_MS)
}

impl Waiting {
    fn close(&self) {
        let Ok(grace) = close_grace() else {
            return;
        };
        let _ = within(grace, async {
            let proxy = Proxy::new(&self.connection, PORTAL_SERVICE, self.path.clone(), REQUEST)
                .await
                .map_err(|error| portal_error(&error))?;
            let _ = proxy.call_method("Close", &()).await;
            Ok(())
        });
    }
}

impl Pending for Waiting {
    fn cancel(self: Box<Self>) {
        self.close();
    }

    fn wait(mut self: Box<Self>, deadline: Deadline) -> Result<PortalAnswer, AdapterError> {
        let answered = within(deadline, async {
            let message = self.stream.next().await.ok_or_else(|| {
                AdapterError::new(
                    ErrorCode::ActionFailed,
                    "The portal request ended with no answer",
                )
            })?;
            let (code, results): (u32, HashMap<String, OwnedValue>) = message
                .body()
                .deserialize()
                .map_err(|error| portal_error(&error))?;
            let uri = results
                .get("uri")
                .and_then(|value| String::try_from(value.clone()).ok());
            Ok(if code == 0 {
                PortalAnswer::Granted { uri }
            } else {
                PortalAnswer::Refused { code }
            })
        });
        if let Err(error) = &answered
            && error.code == ErrorCode::Timeout
        {
            self.close();
        }
        answered
    }
}

impl PortalWire for BusWire {
    fn unique_name(&self) -> String {
        self.connection
            .unique_name()
            .map(|name| name.to_string())
            .unwrap_or_default()
    }

    fn subscribe(
        &self,
        request_path: &str,
        deadline: Deadline,
    ) -> Result<Box<dyn Pending>, AdapterError> {
        let connection = self.connection.clone();
        let path = request_path.to_owned();
        let stream = within(deadline, async {
            let proxy = Proxy::new(&connection, PORTAL_SERVICE, path.clone(), REQUEST)
                .await
                .map_err(|error| portal_error(&error))?;
            proxy
                .receive_signal("Response")
                .await
                .map_err(|error| portal_error(&error))
        })?;
        Ok(Box::new(Waiting {
            connection,
            path,
            stream,
        }))
    }

    fn call_screenshot(&self, token: &str, deadline: Deadline) -> Result<String, AdapterError> {
        within(deadline, async {
            let proxy = Proxy::new(&self.connection, PORTAL_SERVICE, DESKTOP_PATH, SCREENSHOT)
                .await
                .map_err(|error| portal_error(&error))?;
            let mut options: HashMap<&str, Value<'_>> = HashMap::new();
            options.insert("handle_token", Value::from(token));
            options.insert("interactive", Value::from(false));
            let reply = proxy
                .call_method("Screenshot", &("", options))
                .await
                .map_err(|error| portal_error(&error))?;
            let handle: zbus::zvariant::OwnedObjectPath = reply
                .body()
                .deserialize()
                .map_err(|error| portal_error(&error))?;
            Ok(handle.to_string())
        })
    }
}

pub(crate) fn connect(deadline: Deadline) -> Result<Box<dyn PortalWire>, AdapterError> {
    Ok(Box::new(BusWire {
        connection: SessionBus::get(deadline)?,
    }))
}

#[cfg(test)]
#[path = "wayland_portal_bus_tests.rs"]
mod tests;
