use crate::system::shell::call_failure::CallFailure;
use std::future::Future;

use agent_desktop_core::{AdapterError, Deadline, ErrorCode};
use serde_json::json;
use zbus::Connection;

use self::errors::unreadable;
use super::identity::{pick_shell_app, shell_owner};
use crate::system::bus::session_bus::SessionBus;
use crate::system::{NAME_HAS_NO_OWNER, SERVICE_UNKNOWN, SharedBus, within};

const NOTIFICATIONS: &str = "org.freedesktop.Notifications";
const NOTIFICATIONS_PATH: &str = "/org/freedesktop/Notifications";

mod errors;
mod requirements;
mod service;
pub(crate) use requirements::require_daemon;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Fact {
    Present,
    Absent(String),
    Unreadable(String),
}

pub(crate) fn failure_of(error: &zbus::Error) -> CallFailure {
    match error {
        zbus::Error::MethodError(name, _, _)
            if matches!(name.as_str(), SERVICE_UNKNOWN | NAME_HAS_NO_OWNER) =>
        {
            CallFailure::NoService
        }
        other => CallFailure::Transport(other.to_string()),
    }
}

fn call<T>(
    deadline: Deadline,
    read: impl Future<Output = Result<T, zbus::Error>>,
) -> Result<T, CallFailure> {
    match within(deadline, async {
        Ok(read.await.map_err(|error| failure_of(&error)))
    }) {
        Ok(answer) => answer,
        Err(error) => Err(CallFailure::Transport(error.message)),
    }
}

fn server_name(connection: &Connection, deadline: Deadline) -> Result<String, CallFailure> {
    call(deadline, async {
        let reply = connection
            .call_method(
                Some(NOTIFICATIONS),
                NOTIFICATIONS_PATH,
                Some(NOTIFICATIONS),
                "GetServerInformation",
                &(),
            )
            .await?;
        let (name, _vendor, _version, _spec) = reply
            .body()
            .deserialize::<(String, String, String, String)>()?;
        Ok(name)
    })
}

pub(crate) fn classify_daemon(answer: Result<String, CallFailure>) -> (Fact, Option<String>) {
    match answer {
        Ok(name) => (Fact::Present, Some(name)),
        Err(CallFailure::NoService) => (
            Fact::Absent("no service owns org.freedesktop.Notifications".to_owned()),
            None,
        ),
        Err(CallFailure::Transport(detail)) => (Fact::Unreadable(detail), None),
    }
}

pub(crate) fn classify_tree(
    owner: Result<u32, CallFailure>,
    registered: Option<Result<bool, CallFailure>>,
) -> Fact {
    match (owner, registered) {
        (Err(CallFailure::NoService), _) => {
            Fact::Absent("org.gnome.Shell has no owner on the session bus".to_owned())
        }
        (Err(CallFailure::Transport(detail)), _) => Fact::Unreadable(detail),
        (Ok(_), Some(Ok(true))) => Fact::Present,
        (Ok(_), Some(Ok(false))) => {
            Fact::Absent("the shell process is not on the accessibility registry".to_owned())
        }
        (Ok(_), Some(Err(CallFailure::NoService))) => {
            Fact::Absent("the accessibility registry is not answering".to_owned())
        }
        (Ok(_), Some(Err(CallFailure::Transport(detail)))) => Fact::Unreadable(detail),
        (Ok(_), None) => Fact::Unreadable("the registry was not read".to_owned()),
    }
}

pub(crate) fn detect(bus: &SharedBus, deadline: Deadline) -> Fact {
    let session = match SessionBus::get(deadline) {
        Ok(connection) => connection,
        Err(error) => return Fact::Unreadable(error.message),
    };
    let owner = call(deadline, shell_owner(&session));
    let registered = owner.as_ref().ok().map(|pid| {
        let accessibility = bus
            .get(deadline)
            .map_err(|error| CallFailure::Transport(error.message))?;
        within(deadline, super::registry::read(accessibility.inner()))
            .map(|apps| pick_shell_app(&apps, *pid).is_some())
            .map_err(|error| CallFailure::Transport(error.message))
    });
    classify_tree(owner, registered)
}

fn daemon_fact_error(daemon: &Fact, server: Option<&str>) -> Result<(), AdapterError> {
    match daemon {
        Fact::Present => Ok(()),
        Fact::Absent(why) if server.is_some() => Err(AdapterError::new(
            ErrorCode::PlatformNotSupported,
            "The notification service is not the detected shell's own service",
        )
        .with_suggestion("Run the session with the shell's own notification service; another daemon cannot be proven to belong to it")
        .with_details(json!({ "daemon": "unsupported", "detail": why, "server": server }))),
        Fact::Absent(why) => Err(AdapterError::new(
            ErrorCode::PlatformNotSupported,
            "No notification service is running in this session",
        )
        .with_suggestion("Start a notification service implementing org.freedesktop.Notifications")
        .with_details(json!({ "daemon": "absent", "detail": why }))),
        Fact::Unreadable(why) => Err(unreadable("notification service", why, "daemon")),
    }
}

#[cfg(test)]
#[path = "detect_tests.rs"]
mod tests;
