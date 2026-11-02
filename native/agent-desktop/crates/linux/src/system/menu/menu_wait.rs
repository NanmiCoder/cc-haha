use std::cell::RefCell;
use std::time::Duration;

use agent_desktop_core::{AdapterError, Deadline, DeliverySemantics, ErrorCode, ProcessIdentity};

use super::menu_anchor::menu_open;
use crate::system::SharedBus;
use crate::system::interaction::action_clock;
use crate::system::process::liveness::{Liveness, liveness};
use crate::system::process::process_facts::{self, ProcessFacts};

const POLL_INTERVAL: Duration = Duration::from_millis(50);

pub(in crate::system) trait MenuWorld {
    fn process(&self) -> &ProcessIdentity;
    fn liveness(&self) -> Liveness;
    fn menu_open(&self, deadline: Deadline) -> Result<bool, AdapterError>;
    fn pause(&self, gap: Duration);
    fn recent_action(&self) -> bool;

    fn label(&self) -> String {
        let pid = self.process().pid.get();
        app_label(process_facts::read(pid).as_ref(), pid)
    }
}

fn app_label(facts: Option<&ProcessFacts>, pid: u32) -> String {
    facts
        .and_then(|facts| facts.exe_basename.clone().or(Some(facts.comm.clone())))
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| format!("pid {pid}"))
}

struct BusWorld<'a> {
    bus: &'a SharedBus,
    process: ProcessIdentity,
    wake: RefCell<Option<crate::system::signal::subscription::Subscription>>,
}

impl MenuWorld for BusWorld<'_> {
    fn process(&self) -> &ProcessIdentity {
        &self.process
    }

    fn liveness(&self) -> Liveness {
        liveness(self.process.pid.get(), &self.process.instance)
    }

    fn menu_open(&self, deadline: Deadline) -> Result<bool, AdapterError> {
        menu_open(self.bus, &self.process, deadline)
    }

    fn pause(&self, gap: Duration) {
        use agent_desktop_core::WaitWakeup;
        let mut wake = self.wake.borrow_mut();
        if let Some(subscription) = wake.as_mut()
            && let Ok(deadline) = Deadline::after(gap.as_millis().try_into().unwrap_or(u64::MAX))
        {
            if subscription.wait(deadline).is_err() {
                *wake = None;
            }
            return;
        }
        std::thread::sleep(gap);
    }

    fn recent_action(&self) -> bool {
        action_clock::recent_for(self.process.pid.get())
    }
}

fn direction_message(open: bool) -> &'static str {
    if open {
        "No menu opened before the deadline"
    } else {
        "Menu did not close before the deadline"
    }
}

/// The wait's own timeout: the same `wait_timeout` kind and `timeout_ms` the
/// other wait predicates carry, keyed `menu`, with the direction and poll
/// state kept in the platform detail.
fn menu_timeout(open: bool, deadline: Deadline, detail: String) -> AdapterError {
    AdapterError::timeout(direction_message(open))
        .with_details(serde_json::json!({
            "kind": "wait_timeout",
            "predicate": "menu",
            "timeout_ms": deadline.timeout_ms(),
        }))
        .with_platform_detail(detail)
}

fn expiry_detail(open: bool, state_never_read: bool) -> String {
    let direction = direction_message(open);
    if state_never_read {
        format!("{direction}; no poll read the menu state before the deadline")
    } else {
        direction.to_owned()
    }
}

fn stale_process_error(process: &ProcessIdentity) -> AdapterError {
    AdapterError::new(
        ErrorCode::StaleRef,
        "Target process instance is no longer running",
    )
    .with_suggestion(concat!(
        "The application exited during the wait. Re-resolve it with list-apps ",
        "and retry against the new process instance, or treat its exit as the outcome.",
    ))
    .with_disposition(DeliverySemantics::not_delivered())
    .with_details(serde_json::json!({
        "pid": process.pid.get(),
        "process_instance": process.instance,
    }))
}

fn verify_process(world: &impl MenuWorld) -> Result<(), AdapterError> {
    match world.liveness() {
        Liveness::Alive => Ok(()),
        Liveness::Gone => Err(stale_process_error(world.process())),
        Liveness::Stopped => Err(AdapterError::app_unresponsive(&world.label())),
    }
}

pub(in crate::system) fn run(
    world: &impl MenuWorld,
    open: bool,
    deadline: Deadline,
) -> Result<(), AdapterError> {
    let mut state_never_read = true;
    let mut seen_open = false;
    loop {
        verify_process(world)?;
        match world.menu_open(deadline) {
            Ok(state) if state == open && (open || seen_open || !world.recent_action()) => {
                verify_process(world)?;
                return Ok(());
            }
            Ok(state) => {
                state_never_read = false;
                seen_open |= state;
            }
            Err(error) if error.code == ErrorCode::Timeout => {}
            Err(error) => {
                verify_process(world)?;
                return Err(error);
            }
        }
        if deadline.is_expired() {
            return Err(menu_timeout(
                open,
                deadline,
                expiry_detail(open, state_never_read),
            ));
        }
        let gap = deadline
            .remaining_slice(POLL_INTERVAL)
            .map_err(|_| menu_timeout(open, deadline, direction_message(open).to_owned()))?;
        world.pause(gap);
    }
}

pub(crate) fn wait_for_menu(
    bus: &SharedBus,
    process: ProcessIdentity,
    open: bool,
    deadline: Deadline,
) -> Result<(), AdapterError> {
    let wake = crate::system::signal::subscription::Subscription::open(
        bus,
        &agent_desktop_core::SignalFilter {
            process: Some(process.clone()),
            ..Default::default()
        },
        deadline,
    )
    .ok();
    run(
        &BusWorld {
            bus,
            process,
            wake: RefCell::new(wake),
        },
        open,
        deadline,
    )
}

#[cfg(test)]
#[path = "menu_wait_tests.rs"]
mod tests;
