use std::sync::{Mutex, PoisonError};
use std::time::{Duration, Instant};

use agent_desktop_core::{AdapterError, Deadline, DeliverySemantics, ErrorCode};
use serde_json::json;
use zbus::Connection;

use super::light::{LiveNodes, Nodes};
use crate::system::bus::session_bus::SessionBus;
use crate::system::{SharedBus, owner_process_id, within};
use crate::tree::AtspiElement;

pub(crate) const SHELL_BUS_NAME: &str = "org.gnome.Shell";
const WINDOW_RETRIES: usize = 10;
const WINDOW_RETRY_GAP: Duration = Duration::from_millis(100);
const WINDOW_BUDGET: Duration = Duration::from_millis(2_000);
const OUTAGE_MEMORY: Duration = Duration::from_millis(3_000);

static LAST_MISSING: Mutex<Option<Instant>> = Mutex::new(None);

/// A window that has just been missing for a whole retry is still missing a
/// moment later, so the next lookup in the same outage probes once instead of
/// spending the retry again and again until the command's budget is gone.
pub(super) fn retries_after(last_missing: Option<Instant>, now: Instant) -> usize {
    match last_missing {
        Some(at) if now.saturating_duration_since(at) < OUTAGE_MEMORY => 0,
        _ => WINDOW_RETRIES,
    }
}

/// The shell's accessibility application and its content window. `bus_name`
/// is the unique name on the accessibility bus, `pid` the process behind it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ShellRoot {
    pub(crate) bus_name: String,
    pub(crate) path: String,
    pub(crate) pid: u32,
}

pub(crate) fn is_shell_process(pid: u32) -> bool {
    let Ok(deadline) = Deadline::after(1_000) else {
        return false;
    };
    let Ok(session) = SessionBus::get(deadline) else {
        return false;
    };
    within(deadline, shell_pid(&session)).is_ok_and(|owner| owner == Some(pid))
}

/// Requires both bus owners to identify the same current shell process.
pub(crate) fn is_shell_owner(bus_name: &str, pid: u32) -> bool {
    if !is_shell_process(pid) {
        return false;
    }
    let Ok(deadline) = Deadline::after(1_000) else {
        return false;
    };
    let bus = SharedBus::default();
    let Ok(connection) = bus.get(deadline) else {
        return false;
    };
    within(deadline, async {
        owner_process_id(connection.inner(), bus_name)
            .await
            .map_err(|error| crate::system::classify(&error))
    })
    .is_ok_and(|owner| owner == pid)
}

/// The registry application owned by the shell process, from the processes
/// behind the registry's children.
pub(crate) fn pick_shell_app(
    apps: &[(AtspiElement, u32)],
    shell_pid: u32,
) -> Option<&AtspiElement> {
    let mut matching = apps.iter().filter(|(_, pid)| *pid == shell_pid);
    let (app, _) = matching.next()?;
    matching.next().is_none().then_some(app)
}

/// The unique content window among an application's children.
pub(crate) fn content_window<N: Nodes>(
    nodes: &N,
    app: &AtspiElement,
) -> Result<Option<AtspiElement>, AdapterError> {
    let root = nodes.read(app)?;
    let mut found = None;
    for child in &root.children {
        let light = match nodes.read(child) {
            Ok(light) => light,
            Err(error) if error.code == ErrorCode::ElementNotFound => continue,
            Err(error) => return Err(error),
        };
        if light.placed().is_some() {
            if found.is_some() {
                return Err(AdapterError::ambiguous_target(
                    "The shell application exposes several content windows",
                ));
            }
            found = Some(light.element);
        }
    }
    Ok(found)
}

/// Runs `probe` until it answers, at most `1 + attempts` times, pausing
/// between tries and stopping at the deadline. The shell's content window
/// drops out of the registry for a moment after a mutation, so a miss right
/// then is not yet an absent shell.
pub(super) fn retry_until<T>(
    attempts: usize,
    deadline: Deadline,
    pause: &mut dyn FnMut(Duration),
    mut probe: impl FnMut() -> Option<T>,
) -> Option<T> {
    for attempt in 0..=attempts {
        if let Some(found) = probe() {
            return Some(found);
        }
        if attempt == attempts || deadline.is_expired() {
            return None;
        }
        pause(WINDOW_RETRY_GAP);
    }
    None
}

/// The shell is on the bus but its content window is out of the registry,
/// which happens for seconds after a change in the message list while the
/// process stays up. It is named apart from an absent shell and answers
/// within about a second, so a retry a little later is the right move.
pub(super) fn window_missing() -> AdapterError {
    AdapterError::new(
        ErrorCode::AppNotFound,
        "The desktop shell's window is missing from the accessibility registry for the moment",
    )
    .with_suggestion("Retry the command in a few seconds; the shell process is running")
    .with_details(json!({
        "shell_tree": "window_missing",
        "retryable": true,
    }))
    .with_disposition(DeliverySemantics::not_delivered())
}

pub(crate) fn tree_absent(detail: &str) -> AdapterError {
    AdapterError::new(
        ErrorCode::AppNotFound,
        "The GNOME Shell accessibility capability is absent from this session",
    )
    .with_suggestion(
        "Use a GNOME Shell session exposing org.gnome.Shell and its accessibility tree",
    )
    .with_details(json!({ "shell_tree": "absent", "detail": detail }))
}

pub(super) async fn shell_owner(session: &Connection) -> Result<u32, zbus::Error> {
    owner_process_id(session, SHELL_BUS_NAME)
        .await
        .inspect_err(|error| {
            if crate::system::bus::session_bus::is_transport_failure(error) {
                SessionBus::forget(session);
            }
        })
}

async fn shell_pid(session: &Connection) -> Result<Option<u32>, AdapterError> {
    match shell_owner(session).await {
        Ok(pid) => Ok(Some(pid)),
        Err(zbus::Error::MethodError(name, _, _))
            if name.as_str() == crate::system::NAME_HAS_NO_OWNER
                || name.as_str() == crate::system::SERVICE_UNKNOWN =>
        {
            Ok(None)
        }
        Err(error) => Err(crate::system::classify(&error)),
    }
}

pub(crate) fn find_root(bus: &SharedBus, deadline: Deadline) -> Result<ShellRoot, AdapterError> {
    let session = SessionBus::get(deadline)?;
    let accessibility = bus.get(deadline)?.inner().clone();
    let pid = within(deadline, shell_pid(&session))?
        .ok_or_else(|| tree_absent("org.gnome.Shell has no owner on the session bus"))?;
    let apps = within(deadline, super::registry::read(&accessibility))?;
    let app = pick_shell_app(&apps, pid).ok_or_else(|| {
        tree_absent("no unique registry application identifies the shell process")
    })?;
    if crate::system::process::proc_stat::is_stopped(pid) {
        return Err(AdapterError::app_unresponsive(SHELL_BUS_NAME));
    }
    let probe_deadline = deadline.capped(WINDOW_BUDGET);
    let nodes = LiveNodes::new(accessibility, probe_deadline);
    let last = *LAST_MISSING.lock().unwrap_or_else(PoisonError::into_inner);
    let retries = retries_after(last, Instant::now());
    let window = retry_until(retries, probe_deadline, &mut std::thread::sleep, || {
        content_window(&nodes, app).transpose()
    })
    .transpose()?
    .ok_or_else(|| {
        *LAST_MISSING.lock().unwrap_or_else(PoisonError::into_inner) = Some(Instant::now());
        window_missing()
    })?;
    let root = ShellRoot {
        bus_name: window.bus_name().to_owned(),
        path: window.path().to_owned(),
        pid,
    };
    Ok(root)
}

#[cfg(test)]
#[path = "identity_tests.rs"]
mod tests;
