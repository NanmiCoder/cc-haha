#[cfg(target_os = "macos")]
use agent_desktop_core::{AdapterError, Deadline, ErrorCode};

#[cfg(target_os = "macos")]
use crate::tree::AXElement;

#[cfg(target_os = "macos")]
pub(crate) fn select_value(
    element: &AXElement,
    value: &str,
    deadline: Deadline,
) -> Result<bool, AdapterError> {
    prepare(element, deadline)?;
    let role = crate::actions::ax_helpers::element_role(element, deadline)?;
    match select_role_family(role.as_deref()) {
        Some("value_or_menu") => select_combobox(element, value, deadline),
        Some("menu") => crate::actions::select::select_menu::select_from_menu(element, value, deadline),
        Some("collection") => {
            crate::actions::select::select_menu::select_collection_item(element, value, deadline)
        }
        _ => Err(AdapterError::new(
            ErrorCode::ActionNotSupported,
            format!(
                "Select is not supported on role '{}'",
                role.as_deref().unwrap_or("unknown")
            ),
        )
        .with_suggestion(
            "Target a combobox, popup button, menu button, list, table, or outline; otherwise use click.",
        )),
    }
}

#[cfg(target_os = "macos")]
fn select_combobox(
    element: &AXElement,
    value: &str,
    deadline: Deadline,
) -> Result<bool, AdapterError> {
    prepare(element, deadline)?;
    if crate::actions::ax_helpers::is_attr_settable(element, "AXValue", deadline)? {
        match crate::actions::ax_helpers::set_ax_value_coerced(element, value, deadline) {
            Ok(()) => match verify_value(element, value, deadline) {
                Ok(verified) => return Ok(verified),
                Err(error) if should_fallback_after_value_verification(&error) => {
                    return crate::actions::select::select_menu::select_from_menu(
                        element, value, deadline,
                    )
                    .map_err(after_delivery);
                }
                Err(error) => return Err(after_delivery(error)),
            },
            Err(error)
                if error.disposition == agent_desktop_core::DeliverySemantics::not_delivered() => {}
            Err(error) => return Err(error),
        }
    }
    crate::actions::select::select_menu::select_from_menu(element, value, deadline)
}

fn should_fallback_after_value_verification(error: &AdapterError) -> bool {
    error.code == ErrorCode::ActionFailed
        && error
            .details
            .as_ref()
            .and_then(|details| details.get("kind"))
            .and_then(serde_json::Value::as_str)
            == Some("selected_value_not_observed")
}

fn select_role_family(role: Option<&str>) -> Option<&'static str> {
    match role {
        Some("combobox") => Some("value_or_menu"),
        Some("popupbutton" | "menubutton") => Some("menu"),
        Some("list" | "table" | "outline") => Some("collection"),
        _ => None,
    }
}

#[cfg(target_os = "macos")]
fn verify_value(
    element: &AXElement,
    expected: &str,
    deadline: Deadline,
) -> Result<bool, AdapterError> {
    let local_end = std::time::Instant::now() + std::time::Duration::from_millis(600);
    loop {
        prepare(element, deadline)?;
        if crate::tree::copy_value_typed(element, deadline).as_deref() == Some(expected) {
            return Ok(true);
        }
        if deadline.is_expired() {
            return Err(deadline.timeout_error().with_details(serde_json::json!({
                "verification": "selected_value_not_observed",
            })));
        }
        if std::time::Instant::now() >= local_end {
            return Err(AdapterError::new(
                ErrorCode::ActionFailed,
                "Selection write completed but the exact requested value was not observed",
            )
            .with_details(serde_json::json!({
                "kind": "selected_value_not_observed",
            })));
        }
        let pause = deadline.remaining_slice(std::time::Duration::from_millis(25))?;
        std::thread::sleep(pause.min(std::time::Duration::from_millis(25)));
    }
}

#[cfg(target_os = "macos")]
fn after_delivery(error: AdapterError) -> AdapterError {
    let mut delivery = crate::actions::DeliveryTracker::default();
    delivery.mark_delivered();
    delivery.annotate(error)
}

#[cfg(target_os = "macos")]
fn prepare(element: &AXElement, deadline: Deadline) -> Result<(), AdapterError> {
    crate::tree::properties::attributes::set_messaging_timeout(element, deadline)
}

#[cfg(test)]
mod tests {
    use super::{select_role_family, should_fallback_after_value_verification};
    use agent_desktop_core::{AdapterError, ErrorCode};

    #[test]
    fn native_select_roles_keep_their_specialized_paths() {
        assert_eq!(select_role_family(Some("combobox")), Some("value_or_menu"));
        assert_eq!(select_role_family(Some("popupbutton")), Some("menu"));
        assert_eq!(select_role_family(Some("menubutton")), Some("menu"));
        assert_eq!(select_role_family(Some("list")), Some("collection"));
        assert_eq!(select_role_family(Some("table")), Some("collection"));
        assert_eq!(select_role_family(Some("outline")), Some("collection"));
        assert_eq!(select_role_family(Some("button")), None);
    }

    #[test]
    fn completed_combobox_write_with_verify_miss_uses_menu_fallback() {
        let error = AdapterError::new(
            ErrorCode::ActionFailed,
            "Selection write completed but the exact requested value was not observed",
        )
        .with_details(serde_json::json!({
            "kind": "selected_value_not_observed",
        }));

        assert!(should_fallback_after_value_verification(&error));
        assert!(!should_fallback_after_value_verification(
            &AdapterError::timeout("verification timed out")
        ));
    }
}
