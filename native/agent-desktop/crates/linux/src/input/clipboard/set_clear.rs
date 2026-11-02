use std::os::fd::AsRawFd;
use std::path::{Path, PathBuf};

use agent_desktop_core::{
    AdapterError, ClipboardContent, ClipboardFormat, Deadline, DeliverySemantics, ErrorCode,
    InteractionLease,
};

use super::delivery::{fresh_deadline, not_delivered, unresponsive};
use super::owner::owner_locate::locate_helper;
use super::owner::owner_record::{self, OwnerRecord};
use super::owner::owner_signal::{PidfdControl, stop_by_identity};
use super::owner::owner_spawn::{
    ChildProbe, Handshake, await_handshake, kill_and_reap, new_nonce, payload_file, reap_when_done,
};
use super::owner::owner_spawn_spec::{build_command, protect_lease_descriptor};
use super::payload::{Payload, payload_of};
use super::route_fallback::ClipboardTools;
use super::x11_read::{fault_error, read_x11};
use super::x11_requestor::{SelectionServer, X11Server};
use crate::system::display::display_server::{DisplayServer, session_server};
use crate::system::display::route::{self, Route};

pub(crate) struct Env<'a> {
    pub(crate) helper: &'a Path,
    pub(crate) record_dir: &'a Path,
    pub(crate) server: &'a dyn SelectionServer,
    pub(crate) parent_env: &'a dyn Fn(&str) -> Option<String>,
    pub(crate) nonce: &'a str,
}

fn failed(message: impl Into<String>, disposition: DeliverySemantics) -> AdapterError {
    AdapterError::new(ErrorCode::ActionFailed, message).with_disposition(disposition)
}

fn record_read_error(error: std::io::Error, disposition: DeliverySemantics) -> AdapterError {
    let message = format!("Clipboard owner records could not be read: {error}");
    let error = if error.kind() == std::io::ErrorKind::TimedOut {
        AdapterError::timeout(message)
    } else {
        AdapterError::new(ErrorCode::ActionFailed, message)
    };
    error.with_disposition(disposition)
}

fn discard(dir: &Path, display: &str, nonce: &str) {
    if let Some(name) = owner_record::file_name(display, nonce) {
        let _ = super::owner::owner_files::remove(dir, &name);
    }
}

fn retire(env: &Env<'_>, display: &str, record: &OwnerRecord) {
    let _ = stop_by_identity(&PidfdControl, record);
    discard(env.record_dir, display, &record.nonce);
}

fn after_abort(
    env: &Env<'_>,
    display: &str,
    prior: Option<u32>,
    deadline: Deadline,
) -> DeliverySemantics {
    let unchanged =
        prior.is_some() && env.server.owner(display, fresh_deadline(deadline)).ok() == Some(prior);
    if unchanged {
        DeliverySemantics::not_delivered()
    } else {
        DeliverySemantics::uncertain()
    }
}

fn verified(
    env: &Env<'_>,
    display: &str,
    record: &OwnerRecord,
    payload: &Payload,
    deadline: Deadline,
) -> bool {
    let grace = fresh_deadline(deadline);
    let holder = env.server.owner(display, grace);
    let targets = env.server.targets(display, grace);
    matches!(holder, Ok(Some(window)) if window == record.window)
        && targets.is_ok_and(|offered| {
            payload
                .targets
                .iter()
                .all(|target| offered.contains(&target.name))
        })
}

fn start_owner(
    env: &Env<'_>,
    display: &str,
    payload: &Payload,
) -> Result<std::process::Child, AdapterError> {
    let descriptor = payload_file(payload, env.nonce)?;
    protect_lease_descriptor(env.parent_env);
    let spawned = build_command(
        env.helper,
        display,
        env.nonce,
        descriptor.as_raw_fd(),
        env.parent_env,
    )
    .spawn();
    drop(descriptor);
    spawned.map_err(|error| {
        failed(
            format!("The clipboard owner could not start: {error}"),
            DeliverySemantics::not_delivered(),
        )
    })
}

/// Hands the payload to a detached owner and returns once a fresh
/// connection sees that owner serving every target. A helper that stops
/// without a record may have claimed the selection first, so the earlier
/// clipboard counts as intact only when the same client still holds it.
pub(crate) fn set_with(
    env: &Env<'_>,
    display: &str,
    content: &ClipboardContent,
    lease: &InteractionLease,
) -> Result<(), AdapterError> {
    let deadline = lease.deadline();
    let payload = payload_of(content).map_err(not_delivered)?;
    let prior = env
        .server
        .owner(display, deadline)
        .map_err(|fault| fault_error(fault, None))?;
    let earlier = owner_record::records_in(env.record_dir, display, deadline)
        .map_err(|error| record_read_error(error, DeliverySemantics::not_delivered()))?;
    deadline.ensure_remaining().map_err(not_delivered)?;
    let mut child = start_owner(env, display, &payload)?;
    let mut probe = ChildProbe {
        child: &mut child,
        dir: env.record_dir,
        display,
        nonce: env.nonce,
    };
    let handshake = await_handshake(&mut probe, deadline);
    let record = match handshake {
        Handshake::Ready(record) => record,
        Handshake::Failed(message) | Handshake::Exited(message) => {
            kill_and_reap(&mut child);
            discard(env.record_dir, display, env.nonce);
            let disposition = after_abort(env, display, prior, deadline);
            return Err(failed(
                format!("The clipboard owner stopped without serving the selection: {message}"),
                disposition,
            ));
        }
        Handshake::TimedOut => {
            kill_and_reap(&mut child);
            discard(env.record_dir, display, env.nonce);
            let disposition = after_abort(env, display, prior, deadline);
            return Err(
                AdapterError::timeout("The clipboard owner did not report in time")
                    .with_disposition(disposition),
            );
        }
    };
    if let Err(error) = reap_when_done(child) {
        discard(env.record_dir, display, env.nonce);
        return Err(failed(
            format!("The clipboard owner reaper could not start: {error}"),
            DeliverySemantics::uncertain(),
        ));
    }
    if !verified(env, display, &record, &payload, deadline) {
        return Err(unresponsive(
            "The clipboard owner was not seen serving every target",
        ));
    }
    for old in &earlier {
        retire(env, display, old);
    }
    Ok(())
}

/// Leaves `CLIPBOARD` unowned, then ends every recorded owner of this
/// display by identity.
pub(crate) fn clear_with(
    env: &Env<'_>,
    display: &str,
    lease: &InteractionLease,
) -> Result<(), AdapterError> {
    let deadline = lease.deadline();
    env.server
        .release(display, deadline)
        .map_err(|fault| fault_error(fault, None))?;
    let records = owner_record::records_in(env.record_dir, display, deadline)
        .map_err(|error| record_read_error(error, DeliverySemantics::delivered_unverified()))?;
    for record in records {
        retire(env, display, &record);
    }
    match env.server.owner(display, fresh_deadline(deadline)) {
        Ok(None) => Ok(()),
        Ok(Some(_)) => Err(unresponsive(
            "Another client took the clipboard again before the clear finished",
        )),
        Err(_) => Err(unresponsive(
            "The clipboard could not be checked after the clear",
        )),
    }
}

fn with_env<T>(
    helper: PathBuf,
    work: impl FnOnce(&Env<'_>) -> Result<T, AdapterError>,
) -> Result<T, AdapterError> {
    let dir = owner_record::record_dir().ok_or_else(|| {
        failed(
            "The state directory for the clipboard owner is not available",
            DeliverySemantics::not_delivered(),
        )
    })?;
    let nonce = new_nonce();
    let parent_env = |name: &str| std::env::var(name).ok();
    work(&Env {
        helper: &helper,
        record_dir: &dir,
        server: &X11Server,
        parent_env: &parent_env,
        nonce: &nonce,
    })
}

pub(crate) fn set_x11(
    display: &str,
    content: &ClipboardContent,
    lease: &InteractionLease,
) -> Result<(), AdapterError> {
    with_env(locate_helper()?, |env| {
        set_with(env, display, content, lease)
    })
}

pub(crate) fn clear_x11(display: &str, lease: &InteractionLease) -> Result<(), AdapterError> {
    with_env(PathBuf::new(), |env| clear_with(env, display, lease))
}

fn routed(server: DisplayServer) -> Result<Route, AdapterError> {
    route::resolve(server).map_err(not_delivered)
}

pub(crate) fn get_from(
    server: DisplayServer,
    tools: &ClipboardTools,
    format: ClipboardFormat,
    deadline: Deadline,
) -> Result<Option<ClipboardContent>, AdapterError> {
    match routed(server)? {
        Route::X11(display) => read_x11(&display, format, deadline),
        Route::Wayland => tools.read(format, deadline),
    }
}

pub(crate) fn set_from(
    server: DisplayServer,
    tools: &ClipboardTools,
    content: &ClipboardContent,
    lease: &InteractionLease,
) -> Result<(), AdapterError> {
    match routed(server)? {
        Route::X11(display) => set_x11(&display, content, lease),
        Route::Wayland => tools.set(content, lease),
    }
}

pub(crate) fn clear_from(
    server: DisplayServer,
    tools: &ClipboardTools,
    lease: &InteractionLease,
) -> Result<(), AdapterError> {
    match routed(server)? {
        Route::X11(display) => clear_x11(&display, lease),
        Route::Wayland => tools.clear(lease),
    }
}

pub(crate) fn get_clipboard(
    format: ClipboardFormat,
    deadline: Deadline,
) -> Result<Option<ClipboardContent>, AdapterError> {
    get_from(
        session_server(),
        &ClipboardTools::from_process(),
        format,
        deadline,
    )
}

pub(crate) fn set_clipboard(
    content: &ClipboardContent,
    lease: &InteractionLease,
) -> Result<(), AdapterError> {
    set_from(
        session_server(),
        &ClipboardTools::from_process(),
        content,
        lease,
    )
}

pub(crate) fn clear_clipboard(lease: &InteractionLease) -> Result<(), AdapterError> {
    clear_from(session_server(), &ClipboardTools::from_process(), lease)
}

#[cfg(test)]
#[path = "set_clear_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "set_clear_route_tests.rs"]
mod route_tests;

#[cfg(test)]
#[path = "set_clear_live_tests.rs"]
mod live_tests;
