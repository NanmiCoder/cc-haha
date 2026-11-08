use agent_desktop_core::{AdapterError, DeliverySemantics};

use super::standing::Standing;
use super::world::World;
use super::{Request, refusal};
use crate::system::process::liveness::Liveness;
use crate::system::x11::control::ControlRead;
use crate::system::x11::control::control_error::ControlError;

const DIALOG_LOOK_EVERY: u32 = 4;
const SETTLE_LOOKS: u32 = 4;

fn unless_gone(world: &impl World, error: AdapterError) -> Result<bool, AdapterError> {
    if world.liveness() == Liveness::Gone {
        Ok(false)
    } else {
        Err(error)
    }
}

fn not_delivered(error: AdapterError) -> AdapterError {
    error.with_disposition(DeliverySemantics::not_delivered())
}

fn failure_of(world: &impl World, request: &Request<'_>, error: ControlError) -> AdapterError {
    match error {
        ControlError::TimedOut => not_delivered(world.timeout_error()),
        ControlError::StaleWindow => not_delivered(AdapterError::stale_ref_because(
            "The close target's window owner or process instance changed or could not be verified",
        )),
        ControlError::SendFailed => {
            refusal::send_failed(request, error).with_disposition(DeliverySemantics::uncertain())
        }
        other => refusal::send_failed(request, other),
    }
}

fn fan_out(
    world: &impl World,
    request: &Request<'_>,
    windows: &[u32],
) -> Result<bool, AdapterError> {
    let mut sent = 0_usize;
    let mut delivery = DeliverySemantics::not_delivered();
    let mut first_failure = None;
    for window in windows {
        if world.remaining().is_zero() {
            if sent > 0 {
                break;
            }
            return Err(world.timeout_error().with_disposition(delivery));
        }
        match world.request_close(*window) {
            Ok(()) => {
                sent += 1;
                delivery = DeliverySemantics::delivered_unverified();
            }
            Err(ControlError::BadWindow) => {}
            Err(error @ ControlError::StaleWindow) => {
                return Err(failure_of(world, request, error).with_disposition(delivery));
            }
            Err(error) => {
                if error == ControlError::SendFailed && sent == 0 {
                    delivery = DeliverySemantics::uncertain();
                }
                first_failure.get_or_insert_with(|| failure_of(world, request, error));
            }
        }
    }
    if sent > 0 {
        return Ok(true);
    }
    let failure = first_failure
        .unwrap_or_else(|| refusal::windowless(request))
        .with_disposition(delivery);
    if delivery == DeliverySemantics::uncertain() {
        return Err(failure);
    }
    unless_gone(world, failure)
}

fn request_close(world: &impl World, request: &Request<'_>) -> Result<bool, AdapterError> {
    let windows = match world.toplevels() {
        ControlRead::Ready(windows) => windows,
        ControlRead::NotX11 | ControlRead::NoManager if world.on_wayland() => {
            return unless_gone(world, refusal::wayland_session(request));
        }
        ControlRead::NotX11 | ControlRead::NoManager => {
            return unless_gone(world, refusal::no_route(request));
        }
        ControlRead::Unavailable if world.remaining().is_zero() => {
            return Err(not_delivered(world.timeout_error()));
        }
        ControlRead::Unavailable => {
            return unless_gone(world, refusal::unavailable(request));
        }
    };
    match world.liveness() {
        Liveness::Gone => return Ok(false),
        Liveness::Stopped => return Err(AdapterError::app_unresponsive(request.name)),
        Liveness::Alive => {}
    }
    if windows.is_empty() {
        let refused = if world.on_wayland() {
            refusal::wayland_session(request)
        } else {
            refusal::windowless(request)
        };
        return unless_gone(world, refused);
    }
    let standing = Standing::of(world, windows);
    if standing.has_dialog() {
        return Err(refusal::dialog_pending(request, &standing, false));
    }
    let ids: Vec<u32> = standing.windows.iter().map(|window| window.id).collect();
    fan_out(world, request, &ids)
}

/// How the wait for an exit ended.
enum Waited {
    Gone,
    Dialog(Standing),
    TimedOut,
}

/// The wait for the exit. A dialog that opens meanwhile, the save prompt a
/// window raises in answer to its close request, ends the wait at once: the
/// process stays until someone answers it.
fn wait_gone(world: &impl World) -> Waited {
    let mut ticks = 0_u32;
    loop {
        if world.liveness() == Liveness::Gone {
            return Waited::Gone;
        }
        if ticks.is_multiple_of(DIALOG_LOOK_EVERY)
            && let Some(standing) = Standing::read(world)
            && standing.has_dialog()
        {
            return Waited::Dialog(standing);
        }
        if world.remaining().is_zero() {
            return Waited::TimedOut;
        }
        world.pause();
        ticks += 1;
    }
}

/// The windows and dialogs of the process as they stand when its prompt is
/// reported. One close request can raise a prompt for each window with unsaved
/// work, one after the other, and the wait ends on the first it sees. The
/// process is read again until two reads agree, and every count of the result
/// comes from the last read that still shows a prompt, so the result matches
/// what a reader of the session sees a moment later. `None` is a process that
/// exited while it settled.
fn settled(world: &impl World, first: Standing) -> Option<Standing> {
    let mut latest = first;
    for _ in 0..SETTLE_LOOKS {
        if world.liveness() == Liveness::Gone {
            return None;
        }
        if world.remaining().is_zero() {
            break;
        }
        world.pause();
        let Some(read) = Standing::read(world) else {
            break;
        };
        if !read.has_dialog() {
            break;
        }
        let agreed = read == latest;
        latest = read;
        if agreed {
            break;
        }
    }
    (world.liveness() != Liveness::Gone).then_some(latest)
}

/// The close that never signals: close requests to every top-level of the
/// process, then a wait for it to exit. A process that does not exit by the
/// deadline is a `TIMEOUT` with the request delivered and its effect
/// unverified.
pub(super) fn close(world: &impl World, request: &Request<'_>) -> Result<bool, AdapterError> {
    match world.liveness() {
        Liveness::Gone => return Ok(false),
        Liveness::Stopped => return Err(AdapterError::app_unresponsive(request.name)),
        Liveness::Alive => {}
    }
    let sent = request_close(world, request)?;
    if !sent && world.liveness() == Liveness::Gone {
        return Ok(false);
    }
    match wait_gone(world) {
        Waited::Gone => return Ok(sent),
        Waited::Dialog(first) => {
            return match settled(world, first) {
                Some(standing) => Err(refusal::dialog_pending(request, &standing, true)),
                None => Ok(sent),
            };
        }
        Waited::TimedOut => {}
    }
    let remaining = world.toplevels_late().ready();
    Err(refusal::waited_out(
        world.timeout_error(),
        request,
        remaining.as_deref(),
    ))
}

#[cfg(test)]
#[path = "graceful_tests.rs"]
mod tests;
