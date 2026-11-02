use std::time::{Duration, Instant};

use agent_desktop_core::{
    Action, ActionResult, ActionStep, AdapterError, Deadline, DeliverySemantics, ErrorCode,
    StepMechanism,
};
use zbus::Connection;
use zbus::zvariant::Value;

use super::TrayTarget;
use super::call;
use super::menu_layout::{self, Layout, LayoutEntry};
use super::menu_resolve;

const MENU_INTERFACE: &str = "com.canonical.dbusmenu";
const VERIFY_WINDOW: Duration = Duration::from_millis(600);
const VERIFY_POLL: Duration = Duration::from_millis(40);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Pick {
    Clicked,
    ShowSubmenu,
}

fn refused(message: &str, code: ErrorCode) -> AdapterError {
    AdapterError::new(code, message)
        .with_suggestion("Run 'snapshot' to see which menu entries are enabled")
        .with_details(serde_json::json!({ "physical_delivery_started": false }))
        .with_disposition(DeliverySemantics::not_delivered())
}

/// Decides what a pick of `entry` sends. The receiver acts on a click for a
/// disabled entry, a separator or an id that does not exist, so none of those
/// may reach it.
pub(crate) fn validate(entry: &LayoutEntry) -> Result<Pick, AdapterError> {
    if entry.separator {
        return Err(refused(
            "A menu separator cannot be picked",
            ErrorCode::ActionNotSupported,
        ));
    }
    if !entry.enabled {
        return Err(refused(
            &format!("The menu entry '{}' is disabled", entry.label),
            ErrorCode::ActionFailed,
        ));
    }
    Ok(if entry.submenu {
        Pick::ShowSubmenu
    } else {
        Pick::Clicked
    })
}

fn send_clicked(
    connection: &Connection,
    target: &TrayTarget,
    id: i32,
    deadline: Deadline,
) -> Result<(), AdapterError> {
    let menu = target.menu_path.as_deref().unwrap_or_default();
    call::call(
        connection,
        call::Endpoint {
            destination: &target.owner,
            path: menu,
            interface: MENU_INTERFACE,
        },
        "Event",
        &(id, "clicked", Value::from(0i32), 0u32),
        deadline,
    )
    .map(|_| ())
}

fn send_about_to_show(
    connection: &Connection,
    target: &TrayTarget,
    id: i32,
    deadline: Deadline,
) -> Result<(), AdapterError> {
    let menu = target.menu_path.as_deref().unwrap_or_default();
    call::call(
        connection,
        call::Endpoint {
            destination: &target.owner,
            path: menu,
            interface: MENU_INTERFACE,
        },
        "AboutToShow",
        &(id,),
        deadline,
    )
    .map(|_| ())
}

fn reread(
    connection: &Connection,
    target: &TrayTarget,
    deadline: Deadline,
) -> Result<Layout, AdapterError> {
    let menu = target.menu_path.as_deref().unwrap_or_default();
    menu_layout::read(connection, &target.owner, menu, deadline)
}

fn checked_after(
    connection: &Connection,
    target: &TrayTarget,
    before: bool,
    deadline: Deadline,
) -> bool {
    let started = Instant::now();
    loop {
        let flipped = reread(connection, target, deadline)
            .ok()
            .and_then(|layout| menu_resolve::find(&layout, target).ok().map(|e| e.checked))
            .is_some_and(|now| now != Some(before));
        if flipped {
            return true;
        }
        if started.elapsed() >= VERIFY_WINDOW || deadline.is_expired() {
            return false;
        }
        std::thread::sleep(VERIFY_POLL);
    }
}

fn result_of(step: ActionStep) -> ActionResult {
    ActionResult::from_execution(&Action::Click, vec![step])
}

/// Picks the entry a target names: re-reads the layout, validates the entry,
/// sends the click or opens the submenu, then reads the layout again. A
/// checkable entry is verified by its toggle state flipping; any other pick
/// reports delivered-unverified, because the receiver gives no acknowledgement.
pub(crate) fn deliver(
    connection: &Connection,
    target: &TrayTarget,
    deadline: Deadline,
) -> Result<ActionResult, AdapterError> {
    let layout = reread(connection, target, deadline)?;
    let entry = menu_resolve::find(&layout, target)?;
    let id = entry.id;
    match validate(entry)? {
        Pick::Clicked => {
            send_clicked(connection, target, id, deadline)?;
            let step =
                ActionStep::succeeded("dbusmenu-event").with_mechanism(StepMechanism::SemanticApi);
            let verified = entry
                .checked
                .is_some_and(|before| checked_after(connection, target, before, deadline));
            let step = if verified {
                step.with_verified(true)
            } else {
                step
            };
            Ok(result_of(step))
        }
        Pick::ShowSubmenu => {
            send_about_to_show(connection, target, id, deadline)?;
            let step = ActionStep::succeeded("dbusmenu-about-to-show")
                .with_mechanism(StepMechanism::SemanticApi);
            let opened = reread(connection, target, deadline)
                .ok()
                .and_then(|after| {
                    menu_resolve::find(&after, target)
                        .ok()
                        .map(|entry| !entry.children.is_empty())
                })
                .unwrap_or(false);
            Ok(result_of(if opened {
                step.with_verified(true)
            } else {
                step
            }))
        }
    }
}

#[cfg(test)]
#[path = "menu_event_tests.rs"]
mod tests;
