use std::io::ErrorKind;

use agent_desktop_core::{AdapterError, ErrorCode};
use serde_json::json;

use super::bus_stage::Stage;

pub(crate) const SERVICE_UNKNOWN: &str = "org.freedesktop.DBus.Error.ServiceUnknown";
pub(crate) const NAME_HAS_NO_OWNER: &str = "org.freedesktop.DBus.Error.NameHasNoOwner";
const SPAWN_ERROR_PREFIX: &str = "org.freedesktop.DBus.Error.Spawn.";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum BusFault {
    NoSessionBus,
    NotInstalled,
    CannotStart,
    SocketGone,
}

impl BusFault {
    pub(crate) fn of(stage: Stage, error: &zbus::Error) -> Option<Self> {
        match error {
            zbus::Error::InputOutput(io) | zbus::Error::Connection(io, _)
                if matches!(
                    io.kind(),
                    ErrorKind::NotFound | ErrorKind::ConnectionRefused
                ) =>
            {
                Some(Self::unreachable_at(stage))
            }
            zbus::Error::Address(_) => Some(Self::unreachable_at(stage)),
            zbus::Error::MethodError(name, _, _) => match name.as_str() {
                SERVICE_UNKNOWN | NAME_HAS_NO_OWNER => Some(Self::NotInstalled),
                other if other.starts_with(SPAWN_ERROR_PREFIX) => Some(Self::CannotStart),
                _ => None,
            },
            _ => None,
        }
    }

    fn unreachable_at(stage: Stage) -> Self {
        match stage {
            Stage::SessionBus => Self::NoSessionBus,
            Stage::AccessibilityBus => Self::SocketGone,
        }
    }

    pub(crate) fn suggestion(self) -> &'static str {
        match self {
            Self::NoSessionBus => {
                "No D-Bus session bus is reachable. Run inside a desktop session, or start one with 'dbus-run-session -- <command>'."
            }
            Self::NotInstalled => {
                "AT-SPI is not installed or not visible to this process. Install the at-spi2-core package, then retry. Inside Flatpak add '--talk-name=org.a11y.Bus'; inside snap connect the 'desktop-legacy' or 'unity7' interface."
            }
            Self::CannotStart => {
                "AT-SPI is installed but its bus launcher could not start. Read the launch error with 'systemctl --user status at-spi-dbus-bus.service'."
            }
            Self::SocketGone => {
                "The accessibility bus daemon's socket is missing or refusing connections. Restart it with 'systemctl --user restart at-spi-dbus-bus.service', or log out and back in."
            }
        }
    }

    pub(crate) fn into_error(self, source: &zbus::Error) -> AdapterError {
        AdapterError::new(
            ErrorCode::PlatformNotSupported,
            "The AT-SPI accessibility bus is not available in this session",
        )
        .with_suggestion(self.suggestion())
        .with_details(json!({ "retryable": false }))
        .with_platform_detail(source.to_string())
    }
}
