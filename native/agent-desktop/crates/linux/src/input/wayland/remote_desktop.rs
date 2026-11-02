use std::io::ErrorKind;

use agent_desktop_core::{AdapterError, Deadline, DeliverySemantics, ErrorCode};
use serde_json::json;
use zbus::Connection;
use zbus::zvariant::DynamicType;
use zbus::zvariant::OwnedObjectPath;

use super::key_session::KeySession;
use crate::system::bus::session_bus::{SessionBus, is_transport_failure};
use crate::system::{NAME_HAS_NO_OWNER, SERVICE_UNKNOWN, within};

const SERVICE: &str = "org.gnome.Mutter.RemoteDesktop";
const PATH: &str = "/org/gnome/Mutter/RemoteDesktop";
const SESSION_INTERFACE: &str = "org.gnome.Mutter.RemoteDesktop.Session";
const SCREEN_CAST: &str = "org.gnome.Mutter.ScreenCast";
const SCREEN_CAST_PATH: &str = "/org/gnome/Mutter/ScreenCast";
const SCREEN_CAST_SESSION: &str = "org.gnome.Mutter.ScreenCast.Session";
const PROPERTIES: &str = "org.freedesktop.DBus.Properties";
const ACCESS_DENIED: &str = "org.freedesktop.DBus.Error.AccessDenied";

async fn call_session_method<B: zbus::export::serde::Serialize + DynamicType>(
    connection: &Connection,
    path: &str,
    member: &str,
    body: &B,
) -> Result<(), zbus::Error> {
    connection
        .call_method(Some(SERVICE), path, Some(SESSION_INTERFACE), member, body)
        .await
        .map(|_| ())
}

/// A typed view of Mutter's RemoteDesktop service over the session bus
/// connection. It never holds the accessibility connection.
pub(crate) struct RemoteDesktop {
    connection: Connection,
    session: Option<OwnedObjectPath>,
    started: bool,
    stream: Option<OwnedObjectPath>,
}

impl RemoteDesktop {
    pub(crate) fn open(deadline: Deadline) -> Result<Self, AdapterError> {
        let desktop = Self::over(SessionBus::get(deadline)?);
        within(deadline, async {
            let reply = desktop
                .connection
                .call_method(
                    Some(SERVICE),
                    PATH,
                    Some(PROPERTIES),
                    "Get",
                    &(SERVICE, "Version"),
                )
                .await
                .map_err(|error| {
                    if is_transport_failure(&error) {
                        desktop.failed(&error)
                    } else {
                        unsupported_backend(error)
                    }
                })?;
            let version = reply
                .body()
                .deserialize::<zbus::zvariant::OwnedValue>()
                .map_err(unsupported_backend)?;
            i32::try_from(version).map_err(unsupported_backend)?;
            Ok(())
        })
        .map_err(|error| {
            desktop
                .forget_on_timeout(error)
                .with_details(json!({ "backend": SERVICE, "physical_delivery_started": false }))
                .with_disposition(DeliverySemantics::not_delivered())
        })?;
        Ok(desktop)
    }

    pub(crate) fn over(connection: Connection) -> Self {
        Self {
            connection,
            session: None,
            started: false,
            stream: None,
        }
    }

    fn session_path(&self) -> Result<&str, AdapterError> {
        self.session
            .as_ref()
            .map(|path| path.as_str())
            .ok_or_else(|| AdapterError::internal("The keyboard session was not created"))
    }

    fn failed(&self, error: &zbus::Error) -> AdapterError {
        if is_transport_failure(error) {
            SessionBus::forget(&self.connection);
        }
        classify_call(error)
    }

    fn forget_on_timeout(&self, error: AdapterError) -> AdapterError {
        if error.code == ErrorCode::Timeout {
            SessionBus::forget(&self.connection);
        }
        error
    }

    fn call_session(&self, member: &'static str, deadline: Deadline) -> Result<(), AdapterError> {
        let path = self.session_path()?;
        within(deadline, async {
            call_session_method(&self.connection, path, member, &())
                .await
                .map_err(|error| self.failed(&error))
        })
        .map_err(|error| self.forget_on_timeout(error))
    }
}

impl RemoteDesktop {
    pub(crate) fn pointer_button(
        &mut self,
        button: u32,
        down: bool,
        deadline: Deadline,
    ) -> Result<(), AdapterError> {
        let path = self.session_path()?;
        let code = i32::try_from(button)
            .map_err(|_| AdapterError::internal("The pointer button code is out of range"))?;
        within(deadline, async {
            call_session_method(&self.connection, path, "NotifyPointerButton", &(code, down))
                .await
                .map_err(|error| classify_call(&error))
        })
    }
}

impl RemoteDesktop {
    /// Links a screen-cast stream of the monitor on `connector` to the created
    /// session, which is what lets the pointer move to an absolute position.
    pub(crate) fn attach_stream(
        &mut self,
        connector: &str,
        deadline: Deadline,
    ) -> Result<(), AdapterError> {
        let path = self.session_path()?.to_owned();
        let stream = within(deadline, async {
            let id: zbus::zvariant::OwnedValue = self
                .connection
                .call_method(
                    Some(SERVICE),
                    path.as_str(),
                    Some(PROPERTIES),
                    "Get",
                    &(SESSION_INTERFACE, "SessionId"),
                )
                .await
                .map_err(|error| self.failed(&error))?
                .body()
                .deserialize()
                .map_err(|error| self.failed(&error))?;
            let id = String::try_from(id).map_err(|_| AdapterError::internal("no session id"))?;
            let mut options: std::collections::HashMap<&str, zbus::zvariant::Value<'_>> =
                std::collections::HashMap::new();
            options.insert("remote-desktop-session-id", id.as_str().into());
            let cast: OwnedObjectPath = self
                .connection
                .call_method(
                    Some(SCREEN_CAST),
                    SCREEN_CAST_PATH,
                    Some(SCREEN_CAST),
                    "CreateSession",
                    &(options,),
                )
                .await
                .map_err(|error| self.failed(&error))?
                .body()
                .deserialize()
                .map_err(|error| self.failed(&error))?;
            let none: std::collections::HashMap<&str, zbus::zvariant::Value<'_>> =
                std::collections::HashMap::new();
            self.connection
                .call_method(
                    Some(SCREEN_CAST),
                    cast.as_str(),
                    Some(SCREEN_CAST_SESSION),
                    "RecordMonitor",
                    &(connector, none),
                )
                .await
                .map_err(|error| self.failed(&error))?
                .body()
                .deserialize::<OwnedObjectPath>()
                .map_err(|error| self.failed(&error))
        });
        self.stream = Some(stream.map_err(|error| self.forget_on_timeout(error))?);
        Ok(())
    }

    pub(crate) fn pointer_motion_absolute(
        &mut self,
        x: f64,
        y: f64,
        deadline: Deadline,
    ) -> Result<(), AdapterError> {
        let path = self.session_path()?;
        let stream = self
            .stream
            .as_ref()
            .ok_or_else(|| AdapterError::internal("No screen-cast stream is linked"))?
            .as_str();
        within(deadline, async {
            call_session_method(
                &self.connection,
                path,
                "NotifyPointerMotionAbsolute",
                &(stream, x, y),
            )
            .await
            .map_err(|error| classify_call(&error))
        })
    }
}

impl KeySession for RemoteDesktop {
    fn create(&mut self, deadline: Deadline) -> Result<(), AdapterError> {
        let path = within(deadline, async {
            let reply = self
                .connection
                .call_method(Some(SERVICE), PATH, Some(SERVICE), "CreateSession", &())
                .await
                .map_err(|error| self.failed(&error))?;
            reply
                .body()
                .deserialize::<OwnedObjectPath>()
                .map_err(|error| classify_call(&error))
        })
        .map_err(|error| self.forget_on_timeout(error))
        .map_err(creation_failure)?;
        self.session = Some(path);
        Ok(())
    }

    fn start(&mut self, deadline: Deadline) -> Result<(), AdapterError> {
        self.call_session("Start", deadline)?;
        self.started = true;
        Ok(())
    }

    fn resumed(&self) -> bool {
        self.started && self.session.is_some()
    }

    fn retain(&self) -> bool {
        true
    }

    fn keysym(&mut self, keysym: u32, down: bool, deadline: Deadline) -> Result<(), AdapterError> {
        let path = self.session_path()?;
        within(deadline, async {
            call_session_method(
                &self.connection,
                path,
                "NotifyKeyboardKeysym",
                &(keysym, down),
            )
            .await
            .map_err(|error| self.failed(&error))
        })
        .map_err(|error| self.forget_on_timeout(error))
    }

    fn stop(&mut self, deadline: Deadline) -> Result<(), AdapterError> {
        let stopped = self.call_session("Stop", deadline);
        self.session = None;
        self.started = false;
        self.stream = None;
        if stopped.is_err() {
            SessionBus::forget(&self.connection);
        }
        stopped
    }
}

fn unsupported_backend(error: impl std::fmt::Display) -> AdapterError {
    AdapterError::new(
        ErrorCode::PlatformNotSupported,
        "The Mutter RemoteDesktop input capability could not be verified in this Wayland session",
    )
    .with_platform_detail(error.to_string())
    .with_suggestion(
        "Use semantic AT-SPI actions, or a session exposing org.gnome.Mutter.RemoteDesktop",
    )
}

pub(crate) fn semantic_action_refusal(message: impl Into<String>) -> AdapterError {
    AdapterError::new(ErrorCode::ActionNotSupported, message)
        .with_suggestion("Use the semantic action on the element instead of physical input")
        .with_details(json!({ "physical_delivery_started": false }))
        .with_disposition(DeliverySemantics::not_delivered())
}

fn creation_failure(error: AdapterError) -> AdapterError {
    match error.code {
        ErrorCode::Timeout => AdapterError::timeout(
            "The compositor input service did not answer session creation in time",
        )
        .with_suggestion(
            "The desktop session is busy or its input service is unreachable; retry, or use the semantic action",
        )
        .with_details(json!({ "physical_delivery_started": false }))
        .with_disposition(DeliverySemantics::not_delivered()),
        _ => error,
    }
}

pub(crate) fn classify_call(error: &zbus::Error) -> AdapterError {
    match error {
        zbus::Error::InputOutput(io) | zbus::Error::Connection(io, _)
            if io.kind() == ErrorKind::TimedOut =>
        {
            AdapterError::timeout("The compositor did not answer the keyboard request in time")
                .with_platform_detail(error.to_string())
        }
        zbus::Error::MethodError(name, _, _)
            if matches!(
                name.as_str(),
                SERVICE_UNKNOWN | NAME_HAS_NO_OWNER | ACCESS_DENIED
            ) =>
        {
            semantic_action_refusal(
                "Keyboard input through the compositor is not available in this session",
            )
            .with_platform_detail(error.to_string())
        }
        _ => AdapterError::new(
            ErrorCode::ActionFailed,
            "The compositor rejected the keyboard request",
        )
        .with_suggestion("Retry the command; report the platform detail if it persists")
        .with_platform_detail(error.to_string()),
    }
}

#[cfg(test)]
#[path = "remote_desktop_tests.rs"]
mod tests;
