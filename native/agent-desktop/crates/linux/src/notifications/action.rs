use std::time::{Duration, Instant};

use agent_desktop_core::{
    ActionResult, AdapterError, DeliverySemantics, ErrorCode, InteractionLease, MouseButton,
    NotificationActionRequest,
};
use serde_json::json;

use super::extract::Entry;
use super::list::read_listing;
use super::session::{Session, require_headed};
use super::signal::{BusSignals, SETTLE_BUDGET, SignalSource};
use super::target::{Located, Wanted, locate, reconfirm, require};
use super::verify::{REMOVAL_SETTLE, evidence, holds, pressed_without_effect, settle_read};
use super::world::{LiveWorld, ShellWorld};
use crate::system::SharedBus;
use crate::system::shell::light::Light;

const EXPAND_POLL: Duration = Duration::from_millis(100);

pub(crate) fn action(
    bus: &SharedBus,
    request: NotificationActionRequest<'_>,
    lease: &InteractionLease,
) -> Result<ActionResult, AdapterError> {
    action_in(&LiveWorld::new(bus), &BusSignals, request, lease)
}

/// Presses the named action button of the entry at the index, expanding the
/// entry first when its buttons are not laid out. The press only counts when
/// its effect shows: the entry's own object left the list, with the daemon's
/// action signal as the sharper proof when exactly one arrived. A press whose
/// effect never shows is a failure that says it was delivered, and the
/// application's own effect is never claimed. The closed list is read first,
/// so a missing entry or an action it does not offer is refused without
/// opening anything.
pub(crate) fn action_in(
    world: &dyn ShellWorld,
    signals: &dyn SignalSource,
    request: NotificationActionRequest<'_>,
    lease: &InteractionLease,
) -> Result<ActionResult, AdapterError> {
    require_headed(request.policy)?;
    let wanted = Wanted {
        index: request.index,
        app_filter: None,
        identity: request.identity,
    };
    let first = locate(world, wanted, lease.deadline())?;
    offered(first.entry(), request.action_name)?;
    let session = Session::open(world, request.policy, lease)?;
    let result = press(world, signals, (&request, wanted), first.entry(), lease);
    session.finish(result)
}

fn press(
    world: &dyn ShellWorld,
    signals: &dyn SignalSource,
    (request, wanted): (&NotificationActionRequest<'_>, Wanted<'_>),
    first: &Entry,
    lease: &InteractionLease,
) -> Result<ActionResult, AdapterError> {
    let (deadline, name, index) = (lease.deadline(), request.action_name, request.index);
    let mut ready = reconfirm(world, wanted, first, deadline)?;
    if !laid_out(ready.entry(), name) {
        let expand = require(ready.entry().expand(), "expand button", index)?;
        world.click(&expand.element, MouseButton::Left, request.policy, lease)?;
        ready = expanded(world, wanted, first, name, lease)?;
    }
    let button = require(button_named(ready.entry(), name), "action button", index)?;
    let subscription = signals.subscribe(deadline).ok();
    world.click(&button.element, MouseButton::Left, request.policy, lease)?;
    let pressed = Instant::now();
    let after = settle_read(world, deadline, REMOVAL_SETTLE, |now| {
        !holds(now, &first.node)
    })?;
    let seen = subscription
        .map(|held| held.collect(SETTLE_BUDGET.saturating_sub(pressed.elapsed())))
        .unwrap_or_default();
    match evidence(&seen, !holds(&after, &first.node)) {
        Some(proof) => {
            Ok(ActionResult::delivered_unverified(name).with_details(json!({ "evidence": proof })))
        }
        None => Err(pressed_without_effect(
            format!(
                "The '{name}' button was pressed but the notification stayed in the message list"
            ),
            "Run list-notifications; a notification that stays may keep its actions",
        )),
    }
}

fn expanded(
    world: &dyn ShellWorld,
    wanted: Wanted<'_>,
    first: &Entry,
    name: &str,
    lease: &InteractionLease,
) -> Result<Located, AdapterError> {
    loop {
        let ready = reconfirm(world, wanted, first, lease.deadline())
            .map_err(|error| explain_missing(world, error, first, name, lease))?;
        if laid_out(ready.entry(), name) {
            return Ok(ready);
        }
        if lease.deadline().is_expired() {
            return Err(pressed_without_effect(
                format!("The entry was expanded but the '{name}' button never appeared"),
                "Run list-notifications and retry",
            ));
        }
        std::thread::sleep(EXPAND_POLL);
    }
}

/// A reconfirm that finds the entry missing after the expand press is told
/// apart by its object: when the object is gone the press removed the entry,
/// and any other mismatch keeps its own error.
fn explain_missing(
    world: &dyn ShellWorld,
    error: AdapterError,
    first: &Entry,
    name: &str,
    lease: &InteractionLease,
) -> AdapterError {
    let gone = error.code == ErrorCode::NotificationNotFound
        && read_listing(world, lease.deadline()).is_ok_and(|listing| !holds(&listing, &first.node));
    if !gone {
        return error;
    }
    pressed_without_effect(
        format!(
            "The control pressed to reach the '{name}' button removed the notification instead"
        ),
        "Run list-notifications; the shell's header controls are not in the expected order",
    )
}

fn button_named<'a>(entry: &'a Entry, name: &str) -> Option<&'a Light> {
    let wanted = name.to_lowercase();
    entry
        .actions
        .iter()
        .find(|button| button.name.to_lowercase() == wanted)
}

fn laid_out(entry: &Entry, name: &str) -> bool {
    button_named(entry, name).is_some_and(|button| button.placed().is_some())
}

fn offered(entry: &Entry, name: &str) -> Result<(), AdapterError> {
    if button_named(entry, name).is_some() {
        return Ok(());
    }
    let available: Vec<&str> = entry
        .actions
        .iter()
        .map(|button| button.name.as_str())
        .collect();
    Err(AdapterError::new(
        ErrorCode::ActionNotSupported,
        format!(
            "Action '{name}' is not offered by the notification at index {}",
            entry.info.index
        ),
    )
    .with_suggestion("Run list-notifications and use one of the entry's reported actions")
    .with_details(json!({ "available_actions": available }))
    .with_disposition(DeliverySemantics::not_delivered()))
}

#[cfg(test)]
#[path = "action_tests.rs"]
mod tests;
