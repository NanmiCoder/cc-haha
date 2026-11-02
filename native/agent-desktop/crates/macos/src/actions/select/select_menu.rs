use agent_desktop_core::{AdapterError, Deadline, DeliverySemantics, ErrorCode};

use super::select_search::SelectSearch;
use crate::tree::AXElement;

const MAX_SELECT_NODES: usize = 2_048;
const MAX_SELECT_DEPTH: u8 = 8;

pub(crate) fn select_from_menu(
    element: &AXElement,
    value: &str,
    deadline: Deadline,
) -> Result<bool, AdapterError> {
    let pid = require_pid(element, deadline)?;
    let identity = require_identity(pid)?;
    if menu_root(pid, deadline)?.is_some() {
        return Err(AdapterError::new(
            ErrorCode::ActionFailed,
            "Select refused to reuse a menu that was already open",
        )
        .with_suggestion("Dismiss the open menu and retry select."));
    }
    let exposes_value = crate::tree::copy_value_typed(element, deadline).is_some();
    let delivered = open_menu(element, deadline)?;
    if !delivered {
        return Err(AdapterError::new(
            ErrorCode::ActionNotSupported,
            "The target did not support AXShowMenu or AXPress",
        )
        .with_suggestion("Use click to open the control, then snapshot the menu."));
    }
    let result = select_open_menu_item(pid, identity, value, deadline);
    match result {
        Ok(_) if exposes_value => {
            verify_selected_value(element, value, deadline).map_err(after_menu_delivery)
        }
        Ok(verified) => Ok(verified),
        Err(error) => {
            let _ = crate::actions::ax_helpers::try_ax_action_or_err(element, "AXCancel", deadline);
            Err(error.with_disposition(DeliverySemantics::delivered_unverified()))
        }
    }
}

fn verify_selected_value(
    element: &AXElement,
    expected: &str,
    deadline: Deadline,
) -> Result<bool, AdapterError> {
    let local_end = std::time::Instant::now() + std::time::Duration::from_millis(600);
    loop {
        prepare(element, deadline)?;
        if crate::tree::copy_value_typed(element, deadline)
            .as_deref()
            .is_some_and(|value| value.eq_ignore_ascii_case(expected))
        {
            return Ok(true);
        }
        if deadline.is_expired() {
            return Err(deadline.timeout_error().with_details(serde_json::json!({
                "kind": "select_value_not_observed",
                "complete": false,
            })));
        }
        if std::time::Instant::now() >= local_end {
            return Err(AdapterError::new(
                ErrorCode::ActionFailed,
                "The menu item was activated but the control value did not change",
            ));
        }
        let pause = deadline.remaining_slice(std::time::Duration::from_millis(25))?;
        std::thread::sleep(pause.min(std::time::Duration::from_millis(25)));
    }
}

fn after_menu_delivery(error: AdapterError) -> AdapterError {
    error.with_disposition(DeliverySemantics::delivered_unverified())
}

pub(crate) fn select_collection_item(
    element: &AXElement,
    value: &str,
    deadline: Deadline,
) -> Result<bool, AdapterError> {
    let Some(candidate) =
        find_named_descendant(element, value, deadline, SelectSearch::Collection)?
    else {
        return Err(AdapterError::new(
            ErrorCode::ElementNotFound,
            format!(
                "No collection item matched the requested value ({} chars)",
                value.chars().count()
            ),
        )
        .with_suggestion("Use find to inspect the collection's available items.")
        .with_disposition(DeliverySemantics::not_delivered()));
    };
    select_collection_candidate(&candidate, deadline)
}

fn open_menu(element: &AXElement, deadline: Deadline) -> Result<bool, AdapterError> {
    prepare(element, deadline)?;
    if crate::actions::ax_helpers::try_ax_action_or_err(element, "AXShowMenu", deadline)? {
        return Ok(true);
    }
    prepare(element, deadline)?;
    crate::actions::ax_helpers::try_ax_action_or_err(element, "AXPress", deadline)
}

fn select_open_menu_item(
    pid: i32,
    identity: crate::system::process::process_identity::ProcessIdentity,
    value: &str,
    deadline: Deadline,
) -> Result<bool, AdapterError> {
    loop {
        if !identity.still_matches()? {
            return Err(AdapterError::new(
                ErrorCode::AppUnresponsive,
                "The target process changed while selecting a menu item",
            ));
        }
        if let Some(menu) = menu_root(pid, deadline)?
            && let Some(candidate) =
                find_named_descendant(&menu, value, deadline, SelectSearch::MenuItem)?
        {
            let verified = activate_menu_item(&candidate, deadline)?;
            return if verified {
                Ok(true)
            } else {
                wait_for_menu_to_close(pid, deadline)
            };
        }
        if deadline.is_expired() {
            return Err(deadline.timeout_error().with_details(serde_json::json!({
                "kind": "select_menu_item_not_found",
                "requested_chars": value.chars().count(),
                "complete": false,
            })));
        }
        let pause = deadline.remaining_slice(std::time::Duration::from_millis(25))?;
        std::thread::sleep(pause.min(std::time::Duration::from_millis(25)));
    }
}

fn find_named_descendant(
    root: &AXElement,
    value: &str,
    deadline: Deadline,
    search: SelectSearch,
) -> Result<Option<AXElement>, AdapterError> {
    let mut stack = vec![(root.clone(), 0_u8)];
    let mut visited = 0_usize;
    let mut selected: Option<AXElement> = None;
    while let Some((candidate, depth)) = stack.pop() {
        visited = visited.saturating_add(1);
        if visited > MAX_SELECT_NODES {
            return Err(AdapterError::new(
                ErrorCode::AppUnresponsive,
                "Select search exceeded its accessibility-node budget",
            )
            .with_details(serde_json::json!({
                "kind": "select_node_limit",
                "limit": MAX_SELECT_NODES,
                "complete": false,
            })));
        }
        let instant = crate::tree::locator_deadline::from_operation(deadline)?;
        match search {
            SelectSearch::Collection => {
                if let Some(target) =
                    super::select_name::collection_target(&candidate, root, value, instant)?
                {
                    if selected.as_ref().is_some_and(|previous| {
                        !crate::tree::properties::capabilities::same_element(previous, &target)
                    }) {
                        return Err(AdapterError::ambiguous_target(
                            "More than one collection item matched the requested value",
                        )
                        .with_disposition(DeliverySemantics::not_delivered()));
                    }
                    selected = Some(target);
                }
            }
            SelectSearch::MenuItem => {
                if super::select_name::matches(&candidate, value, instant)? {
                    return Ok(Some(candidate));
                }
            }
        }
        let children = boundary_children(depth, search, || {
            crate::tree::surface_read::elements(&candidate, "AXChildren", instant)
        })?;
        stack.extend(
            children
                .into_iter()
                .rev()
                .map(|child| (child, depth.saturating_add(1))),
        );
    }
    Ok(selected)
}

fn boundary_children(
    depth: u8,
    search: SelectSearch,
    read: impl FnOnce() -> Result<Vec<AXElement>, AdapterError>,
) -> Result<Vec<AXElement>, AdapterError> {
    if depth < MAX_SELECT_DEPTH {
        return read();
    }
    if matches!(search, SelectSearch::MenuItem) {
        return Ok(Vec::new());
    }
    if read()?.is_empty() {
        return Ok(Vec::new());
    }
    Err(AdapterError::new(
        ErrorCode::AppUnresponsive,
        "Collection selection search exceeded its depth budget",
    )
    .with_disposition(DeliverySemantics::not_delivered()))
}

fn activate_menu_item(candidate: &AXElement, deadline: Deadline) -> Result<bool, AdapterError> {
    deliver_candidate(false, || Ok(None), || press_candidate(candidate, deadline))
}

fn select_collection_candidate(
    candidate: &AXElement,
    deadline: Deadline,
) -> Result<bool, AdapterError> {
    deliver_candidate(
        true,
        || {
            use crate::actions::chain::chain_delivery::DeliveryOutcome;
            match super::container_select::select_within_container(candidate, deadline)? {
                DeliveryOutcome::NotDelivered => Ok(None),
                outcome => Ok(Some(outcome.was_verified())),
            }
        },
        || press_candidate(candidate, deadline),
    )
}

fn deliver_candidate(
    allow_selected_attribute: bool,
    mut select_attribute: impl FnMut() -> Result<Option<bool>, AdapterError>,
    mut press: impl FnMut() -> Result<bool, AdapterError>,
) -> Result<bool, AdapterError> {
    let selected_error = if allow_selected_attribute {
        match select_attribute() {
            Ok(Some(verified)) => return Ok(verified),
            Ok(None) => None,
            Err(error) if error.disposition == DeliverySemantics::not_delivered() => Some(error),
            Err(error) => return Err(error),
        }
    } else {
        None
    };
    if press()? {
        return Ok(false);
    }
    if let Some(error) = selected_error {
        return Err(error);
    }
    Err(AdapterError::new(
        ErrorCode::ActionNotSupported,
        "The matching selection item did not support AXSelected or AXPress",
    )
    .with_disposition(DeliverySemantics::not_delivered()))
}

fn press_candidate(candidate: &AXElement, deadline: Deadline) -> Result<bool, AdapterError> {
    prepare(candidate, deadline)?;
    crate::actions::ax_helpers::try_ax_action_or_err(candidate, "AXPress", deadline)
}

fn wait_for_menu_to_close(pid: i32, deadline: Deadline) -> Result<bool, AdapterError> {
    let local_end = std::time::Instant::now() + std::time::Duration::from_millis(600);
    loop {
        if menu_root(pid, deadline)?.is_none() {
            return Ok(true);
        }
        if deadline.is_expired() || std::time::Instant::now() >= local_end {
            return Ok(false);
        }
        let pause = deadline.remaining_slice(std::time::Duration::from_millis(25))?;
        std::thread::sleep(pause.min(std::time::Duration::from_millis(25)));
    }
}

fn menu_root(pid: i32, deadline: Deadline) -> Result<Option<AXElement>, AdapterError> {
    let instant = crate::tree::locator_deadline::from_operation(deadline)?;
    crate::tree::surfaces::menu_element_for_pid(pid, instant)
}

fn require_pid(element: &AXElement, deadline: Deadline) -> Result<i32, AdapterError> {
    crate::system::app::app_ops::pid_from_element(element, deadline).ok_or_else(|| {
        AdapterError::new(
            ErrorCode::AppUnresponsive,
            "Could not determine the target process for menu selection",
        )
    })
}

fn require_identity(
    pid: i32,
) -> Result<crate::system::process::process_identity::ProcessIdentity, AdapterError> {
    crate::system::process::process_identity::ProcessIdentity::capture(pid)?.ok_or_else(|| {
        AdapterError::new(
            ErrorCode::AppUnresponsive,
            "The target process exited before menu selection",
        )
    })
}

fn prepare(element: &AXElement, deadline: Deadline) -> Result<(), AdapterError> {
    crate::tree::properties::attributes::set_messaging_timeout(element, deadline)
}

#[cfg(test)]
#[path = "select_menu_tests.rs"]
mod tests;
