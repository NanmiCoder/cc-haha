use super::{AdapterError, ControlRead, DeliverySemantics, ErrorCode, Lookup, OpWorld, WindowInfo};

fn same_instance(world: &impl OpWorld, win: &WindowInfo) -> Option<bool> {
    match world.lookup(win.pid.get()) {
        Lookup::Found(facts) => Some(win.process_instance.as_deref() == Some(&facts.instance)),
        Lookup::Gone => Some(false),
        Lookup::Unreadable => None,
    }
}

pub(super) fn ensure_owned_before(
    world: &impl OpWorld,
    win: &WindowInfo,
) -> Result<(), AdapterError> {
    if win.process_instance.is_none() {
        return Err(AdapterError::stale_ref_because(
            "A window operation needs the process instance the window was listed with",
        )
        .with_disposition(DeliverySemantics::not_delivered()));
    }
    if same_instance(world, win) == Some(false) {
        return Err(AdapterError::stale_ref_because(
            "The window belongs to a different process instance or the process has exited",
        )
        .with_disposition(DeliverySemantics::not_delivered()));
    }
    Ok(())
}

#[cfg(test)]
#[path = "window_op_readback_live_tests.rs"]
mod live_tests;

pub(super) fn ensure_owned_after(
    world: &impl OpWorld,
    win: &WindowInfo,
    client: u32,
) -> Result<(), AdapterError> {
    let owned = match world.clients() {
        ControlRead::Ready(clients) => {
            match clients.iter().find(|candidate| candidate.id == client) {
                Some(candidate) => candidate.pid.map(|pid| pid == win.pid.get()),
                None => Some(false),
            }
        }
        _ => None,
    };
    let instance = same_instance(world, win);
    if instance == Some(false) || owned == Some(false) {
        return Err(AdapterError::new(
            ErrorCode::WindowNotFound,
            "The window disappeared or its owner changed during the operation",
        )
        .with_suggestion("Run 'list-windows' to find the window again")
        .with_disposition(DeliverySemantics::delivered_unverified()));
    }
    if instance.is_none() || owned.is_none() {
        return Err(AdapterError::new(
            ErrorCode::ActionFailed,
            "The window's ownership could not be read back after the operation",
        )
        .with_suggestion("Run 'list-windows' to confirm the window before retrying")
        .with_details(serde_json::json!({ "cause": "ownership_unverified" }))
        .with_disposition(DeliverySemantics::delivered_unverified()));
    }
    Ok(())
}
