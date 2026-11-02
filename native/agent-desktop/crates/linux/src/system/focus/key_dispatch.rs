use agent_desktop_core::{
    ActionResult, AdapterError, Deadline, DeliverySemantics, ErrorCode, InteractionLease,
    InteractionPolicy, KeyCombo, ProcessIdentity, WindowInfo,
};
use serde_json::json;

use crate::input::backend::Backend;
use crate::input::physical::target_keyboard::press_for_process;
use crate::input::physical::target_world::{LiveWorld, PhysicalWorld};
use crate::system::process::process_lookup::Lookup;
use crate::system::window::window_ops::windows_of_process;
use crate::system::x11::stacking::stacking_source::StackingSource;
use crate::system::x11::{DisplayReader, X11State};
use crate::system::{
    SharedBus, listed_app_name,
    process::{proc_stat, process_facts},
};

/// What the key gate reads about the desktop, so the decision can be driven
/// by a fixed desktop.
trait KeyWorld {
    fn lookup(&self, pid: u32) -> Lookup;
    fn stopped(&self, pid: u32) -> bool;
    fn focused_window(
        &self,
        pid: u32,
        deadline: Deadline,
    ) -> Result<Option<WindowInfo>, AdapterError>;
    fn active_client_pid(&self, deadline: Deadline) -> Option<u32>;
}

struct LiveKeys<'a> {
    bus: &'a SharedBus,
}

impl KeyWorld for LiveKeys<'_> {
    fn lookup(&self, pid: u32) -> Lookup {
        process_facts::lookup(pid)
    }

    fn stopped(&self, pid: u32) -> bool {
        proc_stat::is_stopped(pid)
    }

    fn focused_window(
        &self,
        pid: u32,
        deadline: Deadline,
    ) -> Result<Option<WindowInfo>, AdapterError> {
        Ok(windows_of_process(self.bus, pid, deadline)?
            .into_iter()
            .find(|window| window.state.is_focused))
    }

    fn active_client_pid(&self, deadline: Deadline) -> Option<u32> {
        let X11State::Ready { active, clients } = DisplayReader.clients_within(deadline) else {
            return None;
        };
        let active = active?;
        clients
            .iter()
            .find(|client| client.id == active)
            .and_then(|client| client.pid)
    }
}

fn process_gone(process: &ProcessIdentity) -> AdapterError {
    AdapterError::new(
        ErrorCode::AppUnresponsive,
        "Target process instance is no longer running",
    )
    .with_details(json!({
        "pid": process.pid,
        "process_instance": process.instance,
        "physical_delivery_started": false,
    }))
    .with_disposition(DeliverySemantics::not_delivered())
}

fn require_process(world: &impl KeyWorld, process: &ProcessIdentity) -> Result<(), AdapterError> {
    match world.lookup(process.pid.get()) {
        Lookup::Found(facts) if facts.instance != process.instance => Err(process_gone(process)),
        Lookup::Gone => Err(process_gone(process)),
        Lookup::Found(facts) if world.stopped(process.pid.get()) => {
            Err(AdapterError::app_unresponsive(&listed_app_name(&facts))
                .with_disposition(DeliverySemantics::not_delivered()))
        }
        Lookup::Found(_) | Lookup::Unreadable => Ok(()),
    }
}

fn not_active(process: &ProcessIdentity, cause: &'static str) -> AdapterError {
    AdapterError::new(
        ErrorCode::ActionFailed,
        "The target application does not own the active window, so no key was sent",
    )
    .with_details(json!({
        "check": "window_active",
        "cause": cause,
        "pid": process.pid,
        "physical_delivery_started": false,
    }))
    .with_disposition(DeliverySemantics::not_delivered())
}

fn require_active(
    world: &impl KeyWorld,
    backend: &Backend,
    process: &ProcessIdentity,
    window: Option<&WindowInfo>,
    deadline: Deadline,
) -> Result<(), AdapterError> {
    let pid = process.pid.get();
    let display_active =
        !matches!(backend, Backend::X11(_)) || world.active_client_pid(deadline) == Some(pid);
    if !display_active {
        return Err(match window {
            Some(window) => window_not_active(window),
            None => not_active(process, "display_active_window"),
        });
    }
    let focused = world.focused_window(pid, deadline);
    if let Some(window) = window {
        return if focused.ok().flatten().is_some_and(|focused| {
            focused.id == window.id
                && focused.pid == process.pid
                && focused.process_instance.as_deref() == Some(process.instance.as_str())
        }) {
            Ok(())
        } else {
            Err(window_not_active(window))
        };
    }
    match focused? {
        Some(focused) if focused.pid.get() == pid => Ok(()),
        Some(_) => Err(not_active(process, "other_application")),
        None => Err(not_active(process, "frame_not_active")),
    }
}

fn window_not_active(window: &WindowInfo) -> AdapterError {
    AdapterError::stale_ref_because(
        "The named window's exact focus could not be confirmed, so no key was sent",
    )
    .with_suggestion("Bring the named window to the front, refresh list-windows, and retry")
    .with_details(json!({
        "check": "exact_window_focus",
        "cause": "exact_window_focus_unconfirmed",
        "window_id": window.id,
        "physical_delivery_started": false,
    }))
    .with_disposition(DeliverySemantics::not_delivered())
}

fn after_delivery(
    world: &impl KeyWorld,
    process: &ProcessIdentity,
    result: ActionResult,
) -> Result<ActionResult, AdapterError> {
    require_process(world, process).map_err(|error| {
        error
            .with_details(json!({
                "pid": process.pid,
                "process_instance": process.instance,
                "physical_delivery_started": true,
            }))
            .with_disposition(DeliverySemantics::delivered_unverified())
    })?;
    Ok(result)
}

/// One chord for one process, with the two views of the desktop that decide
/// whether it may be sent.
struct Press<'a, P, K> {
    physical: &'a P,
    keys: &'a K,
    process: &'a ProcessIdentity,
    window: Option<&'a WindowInfo>,
    combo: &'a KeyCombo,
    policy: InteractionPolicy,
    deadline: Deadline,
}

fn press_in(
    request: Press<'_, impl PhysicalWorld, impl KeyWorld>,
) -> Result<ActionResult, AdapterError> {
    let Press {
        physical,
        keys,
        process,
        window,
        combo,
        policy,
        deadline,
    } = request;
    let backend = physical.backend()?;
    let mut gate = || {
        require_process(keys, process)?;
        require_active(keys, &backend, process, window, deadline)
    };
    let result = press_for_process(physical, combo, policy, &mut gate, deadline)?;
    after_delivery(keys, process, result)
}

pub(crate) fn press_key_for_app(
    bus: &SharedBus,
    process: ProcessIdentity,
    combo: &KeyCombo,
    policy: InteractionPolicy,
    lease: &InteractionLease,
) -> Result<ActionResult, AdapterError> {
    crate::system::display::display_server::require(lease.deadline())
        .map_err(|error| error.with_disposition(DeliverySemantics::not_delivered()))?;
    press_in(Press {
        physical: &LiveWorld { bus, lease },
        keys: &LiveKeys { bus },
        process: &process,
        window: None,
        combo,
        policy,
        deadline: lease.deadline(),
    })
}

pub(crate) fn press_key_for_window(
    bus: &SharedBus,
    window: &WindowInfo,
    combo: &KeyCombo,
    policy: InteractionPolicy,
    lease: &InteractionLease,
) -> Result<ActionResult, AdapterError> {
    crate::system::display::display_server::require(lease.deadline())
        .map_err(|error| error.with_disposition(DeliverySemantics::not_delivered()))?;
    let instance = window
        .process_instance
        .as_deref()
        .filter(|instance| !instance.is_empty())
        .ok_or_else(|| window_not_active(window))?;
    press_in(Press {
        physical: &LiveWorld { bus, lease },
        keys: &LiveKeys { bus },
        process: &ProcessIdentity::new(window.pid, instance),
        window: Some(window),
        combo,
        policy,
        deadline: lease.deadline(),
    })
}

#[cfg(test)]
#[path = "key_dispatch_tests.rs"]
mod tests;
