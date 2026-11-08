use agent_desktop_core::{AdapterError, Deadline, DeliverySemantics, ErrorCode};
use serde_json::json;

use super::focus_cause::Cause;
use crate::system::window::window_op::window_op_verdict::{POLL, SETTLE_BUDGET};
use crate::system::x11::control::control_error::ControlError;
use crate::system::x11::control::control_send::activate_window;
use crate::system::x11::control::window_facts::{WindowFacts, read_facts};
use crate::system::x11::control::{ControlRead, manager_name};

const UNNAMED_MANAGER: &str = "the window manager";

/// What lifting a hidden window found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Lifted {
    Cleared,
    StillHidden { manager: String },
}

/// What a lift sends and reads, so the judgement can be driven by a fixed
/// desktop.
trait LiftWorld {
    fn activate(&self, client: u32, deadline: Deadline) -> Result<(), ControlError>;
    fn facts(&self, client: u32, deadline: Deadline) -> ControlRead<WindowFacts>;
    fn manager(&self, deadline: Deadline) -> Option<String>;
}

struct Live<'a>(&'a agent_desktop_core::ProcessIdentity);

impl LiftWorld for Live<'_> {
    fn activate(&self, client: u32, deadline: Deadline) -> Result<(), ControlError> {
        activate_window(client, self.0, deadline, false)
    }

    fn facts(&self, client: u32, deadline: Deadline) -> ControlRead<WindowFacts> {
        read_facts(client, self.0, deadline)
    }

    fn manager(&self, deadline: Deadline) -> Option<String> {
        manager_name(deadline)
    }
}

/// The refusal of a window the manager left hidden after the request. While
/// the Activities Overview is open the manager shows no window, so the
/// refusal names the overview as the cause and not the manager.
pub(in crate::system) fn still_hidden(manager: &str, overview_open: bool) -> AdapterError {
    if overview_open {
        return AdapterError::new(
            ErrorCode::ActionFailed,
            format!(
                "The Activities Overview is open, so the window manager {manager} did not show the minimized window"
            ),
        )
        .with_suggestion("Close the Activities Overview (press Escape), then retry")
        .with_details(json!({ "cause": Cause::OverviewOpen.as_str(), "manager": manager }))
        .with_disposition(DeliverySemantics::delivered_unverified());
    }
    AdapterError::new(
        ErrorCode::ActionNotSupported,
        format!("The window manager {manager} did not show the minimized window"),
    )
    .with_suggestion("Show the window yourself, for example from the taskbar or the overview")
    .with_details(json!({ "cause": "restore_refused", "manager": manager }))
    .with_disposition(DeliverySemantics::delivered_unverified())
}

fn activation_failed(error: ControlError) -> AdapterError {
    if error == ControlError::SendFailed {
        return AdapterError::new(
            ErrorCode::ActionFailed,
            "The restore request was not confirmed by the display server",
        )
        .with_suggestion(
            "Run 'list-windows' to read the window state before deciding whether to retry",
        )
        .with_details(json!({ "cause": "activation_unconfirmed" }))
        .with_disposition(DeliverySemantics::uncertain());
    }
    if error == ControlError::TimedOut {
        return AdapterError::timeout(
            "The display server did not accept the restore request in time",
        )
        .with_disposition(DeliverySemantics::not_delivered());
    }
    if error == ControlError::StaleWindow {
        return AdapterError::stale_ref_because("The window owner changed before restoration")
            .with_disposition(DeliverySemantics::not_delivered());
    }
    AdapterError::new(
        ErrorCode::ActionFailed,
        "The request to show the window could not be sent to the window manager",
    )
    .with_suggestion("Retry once the display server answers")
    .with_details(json!({ "cause": "activation_not_sent" }))
    .with_disposition(DeliverySemantics::not_delivered())
}

fn unreadable() -> AdapterError {
    AdapterError::new(
        ErrorCode::ActionFailed,
        "The window could not be read after the request to show it, so its state is unknown",
    )
    .with_suggestion("Run 'list-windows' to see the window as it is now")
    .with_details(json!({ "cause": "readback_unavailable" }))
    .with_disposition(DeliverySemantics::delivered_unverified())
}

fn lift_via(
    world: &impl LiftWorld,
    client: u32,
    deadline: Deadline,
) -> Result<Lifted, AdapterError> {
    world
        .activate(client, deadline)
        .map_err(activation_failed)?;
    let settle = deadline.capped(SETTLE_BUDGET);
    let mut read_once = false;
    loop {
        if let ControlRead::Ready(facts) = world.facts(client, deadline) {
            read_once = true;
            if !facts.hidden {
                return Ok(Lifted::Cleared);
            }
        }
        if settle.is_expired() {
            break;
        }
        std::thread::sleep(POLL.min(settle.remaining()));
    }
    if !read_once {
        return Err(unreadable());
    }
    let manager = world
        .manager(deadline)
        .unwrap_or_else(|| UNNAMED_MANAGER.to_owned());
    Ok(Lifted::StillHidden { manager })
}

/// Asks the window manager to show a hidden window and reports whether the
/// hidden flag cleared inside the settle budget. The request is
/// judged by the flag, never by having been sent.
pub(crate) fn lift(
    client: u32,
    owner: &agent_desktop_core::ProcessIdentity,
    deadline: Deadline,
) -> Result<Lifted, AdapterError> {
    lift_via(&Live(owner), client, deadline)
}

#[cfg(test)]
#[path = "restore_minimized_tests.rs"]
mod tests;
