use agent_desktop_core::{AdapterError, Deadline};

use crate::actions::chain::chain_delivery::DeliveryOutcome;
use crate::tree::AXElement;

const MAX_MENU_SEARCH_NODES: usize = 2_048;

pub(crate) fn show_menu(
    element: &AXElement,
    deadline: Deadline,
) -> Result<DeliveryOutcome, AdapterError> {
    show_menu_on_element(element, deadline)
}

pub(crate) fn show_menu_on_ancestors(
    element: &AXElement,
    deadline: Deadline,
) -> Result<DeliveryOutcome, AdapterError> {
    let mut current = parent(element, deadline)?;
    for _ in 0..3 {
        let Some(ancestor) = current else {
            return Ok(DeliveryOutcome::NotDelivered);
        };
        let outcome = show_menu_on_element(&ancestor, deadline)?;
        if outcome.terminates_chain() {
            return Ok(outcome);
        }
        current = parent(&ancestor, deadline)?;
    }
    Ok(DeliveryOutcome::NotDelivered)
}

pub(crate) fn show_menu_on_children(
    element: &AXElement,
    deadline: Deadline,
) -> Result<DeliveryOutcome, AdapterError> {
    let instant = instant(deadline)?;
    for child in crate::tree::surface_read::elements(element, "AXChildren", instant)?
        .into_iter()
        .take(5)
    {
        let outcome = show_menu_on_element(&child, deadline)?;
        if outcome.terminates_chain() {
            return Ok(outcome);
        }
    }
    Ok(DeliveryOutcome::NotDelivered)
}

pub(crate) fn select_then_show_menu(
    element: &AXElement,
    deadline: Deadline,
) -> Result<DeliveryOutcome, AdapterError> {
    if !select_containing_item(element, deadline)? {
        return Ok(DeliveryOutcome::NotDelivered);
    }
    show_menu_on_element(element, deadline)
}

pub(crate) fn select_then_selected_items_menu(
    element: &AXElement,
    deadline: Deadline,
) -> Result<DeliveryOutcome, AdapterError> {
    if !select_containing_item(element, deadline)? {
        return Ok(DeliveryOutcome::NotDelivered);
    }
    let Some(window) = window_ancestor(element, deadline)? else {
        return Ok(DeliveryOutcome::NotDelivered);
    };
    let Some(menu_button) = selected_items_menu_button(&window, deadline)? else {
        return Ok(DeliveryOutcome::NotDelivered);
    };
    show_menu_or_press(&menu_button, deadline)
}

fn show_menu_on_element(
    element: &AXElement,
    deadline: Deadline,
) -> Result<DeliveryOutcome, AdapterError> {
    let Some(pid) = crate::system::app::app_ops::pid_from_element(element, deadline) else {
        return Ok(DeliveryOutcome::NotDelivered);
    };
    if menu_probe(pid, deadline) {
        return Ok(DeliveryOutcome::NotDelivered);
    }
    prepare(element, deadline)?;
    let delivered =
        crate::actions::ax_helpers::try_ax_action_or_err(element, "AXShowMenu", deadline)?;
    if !delivered {
        return Ok(DeliveryOutcome::NotDelivered);
    }
    Ok(DeliveryOutcome::from_delivery(
        true,
        wait_for_new_menu(pid, deadline)?,
    ))
}

fn show_menu_or_press(
    element: &AXElement,
    deadline: Deadline,
) -> Result<DeliveryOutcome, AdapterError> {
    let Some(pid) = crate::system::app::app_ops::pid_from_element(element, deadline) else {
        return Ok(DeliveryOutcome::NotDelivered);
    };
    if menu_probe(pid, deadline) {
        return Ok(DeliveryOutcome::NotDelivered);
    }
    for action in ["AXShowMenu", "AXPress"] {
        prepare(element, deadline)?;
        if crate::actions::ax_helpers::try_ax_action_or_err(element, action, deadline)? {
            return Ok(DeliveryOutcome::from_delivery(
                true,
                wait_for_new_menu(pid, deadline)?,
            ));
        }
    }
    Ok(DeliveryOutcome::NotDelivered)
}

fn wait_for_new_menu(pid: i32, deadline: Deadline) -> Result<bool, AdapterError> {
    let local_end = std::time::Instant::now() + std::time::Duration::from_millis(600);
    loop {
        if menu_probe(pid, deadline) {
            return Ok(true);
        }
        if deadline.is_expired() || std::time::Instant::now() >= local_end {
            return Ok(false);
        }
        let pause = deadline.remaining_slice(std::time::Duration::from_millis(25))?;
        std::thread::sleep(pause.min(std::time::Duration::from_millis(25)));
    }
}

/// An application in menu tracking stops answering child reads, so a failed
/// probe is the expected shape of "a menu is up" rather than an application
/// fault. Verification must never turn a delivered action into an error.
fn menu_probe(pid: i32, deadline: Deadline) -> bool {
    instant(deadline)
        .and_then(|instant| crate::tree::surfaces::is_menu_open(pid, instant))
        .unwrap_or(false)
}

fn select_containing_item(element: &AXElement, deadline: Deadline) -> Result<bool, AdapterError> {
    let mut current = Some(element.clone());
    for _ in 0..4 {
        let Some(candidate) = current else {
            return Ok(false);
        };
        prepare(&candidate, deadline)?;
        if crate::actions::ax_helpers::is_attr_settable(&candidate, "AXSelected", deadline)? {
            prepare(&candidate, deadline)?;
            if crate::actions::ax_helpers::set_ax_bool_or_err(
                &candidate,
                "AXSelected",
                true,
                deadline,
            )? {
                return selected(&candidate, deadline);
            }
        }
        current = parent(&candidate, deadline)?;
    }
    Ok(false)
}

fn selected(element: &AXElement, deadline: Deadline) -> Result<bool, AdapterError> {
    Ok(
        crate::tree::surface_read::boolean(element, "AXSelected", instant(deadline)?)?
            == Some(true),
    )
}

fn window_ancestor(
    element: &AXElement,
    deadline: Deadline,
) -> Result<Option<AXElement>, AdapterError> {
    let mut current = parent(element, deadline)?;
    for _ in 0..20 {
        let Some(ancestor) = current else {
            return Ok(None);
        };
        if crate::tree::surface_read::string(&ancestor, "AXRole", instant(deadline)?)?.as_deref()
            == Some("AXWindow")
        {
            return Ok(Some(ancestor));
        }
        current = parent(&ancestor, deadline)?;
    }
    Ok(None)
}

fn selected_items_menu_button(
    root: &AXElement,
    deadline: Deadline,
) -> Result<Option<AXElement>, AdapterError> {
    let mut stack = vec![(root.clone(), 0_u8)];
    let mut visited = 0_usize;
    while let Some((candidate, depth)) = stack.pop() {
        visited = visited.saturating_add(1);
        if visited > MAX_MENU_SEARCH_NODES {
            return Err(AdapterError::new(
                agent_desktop_core::ErrorCode::AppUnresponsive,
                "Selected-items menu search exceeded its accessibility-node budget",
            )
            .with_details(serde_json::json!({
                "kind": "selected_items_menu_node_limit",
                "limit": MAX_MENU_SEARCH_NODES,
                "complete": false,
            })));
        }
        if is_selected_items_control(&candidate, deadline)? {
            return Ok(Some(candidate));
        }
        if depth >= 8 {
            continue;
        }
        stack.extend(
            crate::tree::surface_read::elements(&candidate, "AXChildren", instant(deadline)?)?
                .into_iter()
                .rev()
                .map(|child| (child, depth.saturating_add(1))),
        );
    }
    Ok(None)
}

fn is_selected_items_control(
    element: &AXElement,
    deadline: Deadline,
) -> Result<bool, AdapterError> {
    if crate::tree::surface_read::string(element, "AXRole", instant(deadline)?)?.as_deref()
        != Some("AXMenuButton")
    {
        return Ok(false);
    }
    for attribute in ["AXHelp", "AXDescription", "AXTitle"] {
        if crate::tree::surface_read::string(element, attribute, instant(deadline)?)?
            .is_some_and(|value| value.to_ascii_lowercase().contains("selected item"))
        {
            return Ok(true);
        }
    }
    Ok(false)
}

fn parent(element: &AXElement, deadline: Deadline) -> Result<Option<AXElement>, AdapterError> {
    crate::tree::surface_read::element(element, "AXParent", instant(deadline)?)
}

fn instant(deadline: Deadline) -> Result<std::time::Instant, AdapterError> {
    crate::tree::locator_deadline::from_operation(deadline)
}

fn prepare(element: &AXElement, deadline: Deadline) -> Result<(), AdapterError> {
    crate::tree::properties::attributes::set_messaging_timeout(element, deadline)
}
