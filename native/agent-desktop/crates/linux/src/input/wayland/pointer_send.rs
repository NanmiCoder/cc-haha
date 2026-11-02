use std::time::Duration;

use agent_desktop_core::{
    AdapterError, Deadline, DeliverySemantics, DisplayInfo, ErrorCode, MouseButton, MouseEvent,
    Point,
};
use serde_json::json;

use super::key_session::KeySession;
use super::remote_desktop::RemoteDesktop;
use crate::input::delivery::Gate;
use crate::input::physical::shell_aim::display_under;

pub(crate) fn send(
    event: &MouseEvent,
    displays: &[DisplayInfo],
    gate: Gate<'_>,
    deadline: Deadline,
) -> Result<(), AdapterError> {
    let mut session = RemoteDesktop::open(deadline)?;
    run_pointer(&mut session, event, displays, gate, deadline)
}

fn monitor_under(point: &Point, displays: &[DisplayInfo]) -> Option<(String, Point)> {
    let display = display_under(point, displays)?;
    let connector = display.id.split('+').next().unwrap_or_default().to_owned();
    Some((
        connector,
        Point {
            x: point.x - display.bounds.x,
            y: point.y - display.bounds.y,
        },
    ))
}

const SETTLE_PAUSE: Duration = Duration::from_millis(150);
const PRESS_PAUSE: Duration = Duration::from_millis(60);
const RECOVERY_MS: u64 = 1_000;
const BTN_LEFT: u32 = 272;
const BTN_RIGHT: u32 = 273;
const BTN_MIDDLE: u32 = 274;
pub(crate) trait PointerSession: KeySession {
    fn button(&mut self, button: u32, down: bool, deadline: Deadline) -> Result<(), AdapterError>;
    fn pause(&mut self, duration: Duration) {
        std::thread::sleep(duration);
    }
    fn attach_stream(&mut self, connector: &str, deadline: Deadline) -> Result<(), AdapterError>;
    fn motion_absolute(&mut self, x: f64, y: f64, deadline: Deadline) -> Result<(), AdapterError>;
}
impl PointerSession for RemoteDesktop {
    fn button(&mut self, button: u32, down: bool, deadline: Deadline) -> Result<(), AdapterError> {
        self.pointer_button(button, down, deadline)
    }

    fn attach_stream(&mut self, connector: &str, deadline: Deadline) -> Result<(), AdapterError> {
        RemoteDesktop::attach_stream(self, connector, deadline)
    }

    fn motion_absolute(&mut self, x: f64, y: f64, deadline: Deadline) -> Result<(), AdapterError> {
        self.pointer_motion_absolute(x, y, deadline)
    }
}

fn button_code(button: &MouseButton) -> u32 {
    match button {
        MouseButton::Left => BTN_LEFT,
        MouseButton::Right => BTN_RIGHT,
        MouseButton::Middle => BTN_MIDDLE,
    }
}

fn press<S: PointerSession>(
    session: &mut S,
    code: u32,
    deadline: Deadline,
) -> Result<(), AdapterError> {
    session.button(code, true, deadline).map_err(|error| {
        if error.disposition == DeliverySemantics::not_delivered() {
            error
        } else {
            delivery_error(error, DeliverySemantics::uncertain())
        }
    })?;
    session.pause(PRESS_PAUSE);
    session
        .button(code, false, recovery_deadline(deadline))
        .map_err(|error| delivery_error(error, DeliverySemantics::uncertain()))
}

fn delivery_error(error: AdapterError, disposition: DeliverySemantics) -> AdapterError {
    let details = error.details.clone().unwrap_or_else(|| json!({}));
    let mut details = match details {
        serde_json::Value::Object(details) => details,
        other => serde_json::Map::from_iter([("cause".to_owned(), other)]),
    };
    details.insert("physical_delivery_started".to_owned(), json!(true));
    error
        .with_details(serde_json::Value::Object(details))
        .with_disposition(disposition)
        .with_suggestion("Inspect the target with 'snapshot' before retrying; some physical input may already have been delivered")
}

fn execute_created_session<S: PointerSession>(
    session: &mut S,
    deadline: Deadline,
    execute: impl FnOnce(&mut S) -> Result<(), AdapterError>,
) -> Result<(), AdapterError> {
    match (execute(session), session.stop(recovery_deadline(deadline))) {
        (Ok(()), Err(error)) => Err(delivery_error(
            error,
            DeliverySemantics::delivered_unverified(),
        )),
        (result, _) => result,
    }
}

/// Release and Stop get their own budget after a click exhausts its deadline.
fn recovery_deadline(spent: Deadline) -> Deadline {
    Deadline::detached_after(RECOVERY_MS).unwrap_or(spent)
}

pub(crate) fn run_pointer<S: PointerSession>(
    session: &mut S,
    event: &MouseEvent,
    displays: &[DisplayInfo],
    gate: Gate<'_>,
    deadline: Deadline,
) -> Result<(), AdapterError> {
    let (connector, local) = monitor_under(&event.point, displays).ok_or_else(|| {
        AdapterError::new(
            ErrorCode::ActionFailed,
            "The pointer is outside every readable display",
        )
        .with_disposition(DeliverySemantics::not_delivered())
    })?;
    session.create(deadline)?;
    execute_created_session(session, deadline, |session| {
        session
            .attach_stream(&connector, deadline)
            .map_err(|mut error| {
                error.details.get_or_insert_with(|| json!({}))["physical_delivery_started"] =
                    false.into();
                error.with_disposition(DeliverySemantics::not_delivered())
            })?;
        session.start(deadline).map_err(|mut error| {
            error.details.get_or_insert_with(|| json!({}))["physical_delivery_started"] =
                false.into();
            error.with_disposition(DeliverySemantics::not_delivered())
        })?;
        gate()?;
        session
            .motion_absolute(local.x, local.y, deadline)
            .map_err(|error| delivery_error(error, DeliverySemantics::uncertain()))?;
        session.pause(SETTLE_PAUSE);
        gate().map_err(|error| delivery_error(error, DeliverySemantics::delivered_unverified()))?;
        press(session, button_code(&event.button), deadline).map_err(|error| {
            if error.disposition == DeliverySemantics::not_delivered() {
                delivery_error(error, DeliverySemantics::delivered_unverified())
            } else {
                error
            }
        })
    })
}

#[cfg(test)]
#[path = "target_pointer_tests.rs"]
mod tests;
