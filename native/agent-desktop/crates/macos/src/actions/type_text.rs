use agent_desktop_core::{
    ActionStep, AdapterError, Deadline, DeliverySemantics, ErrorCode, InteractionPolicy,
    StepMechanism,
};

use crate::tree::AXElement;

pub(crate) fn execute_type(
    element: &AXElement,
    text: &str,
    policy: InteractionPolicy,
    deadline: Deadline,
) -> Result<ActionStep, AdapterError> {
    if !is_text_target(element, deadline)? {
        return Err(AdapterError::new(
            ErrorCode::ActionNotSupported,
            "Type requires a text field, secure text field, or combo box",
        ));
    }
    if policy.is_headed() {
        crate::actions::physical_keyboard::type_text(element, text, policy, deadline)?;
        return Ok(ActionStep::succeeded("PIDTargetedUnicodeText")
            .with_mechanism(StepMechanism::PhysicalSynthetic)
            .with_verified(false));
    }
    insert_selected_text(element, text, deadline)?;
    Ok(ActionStep::succeeded("AXSelectedText")
        .with_mechanism(StepMechanism::SemanticApi)
        .with_verified(false))
}

fn insert_selected_text(
    element: &AXElement,
    text: &str,
    deadline: Deadline,
) -> Result<(), AdapterError> {
    prepare(element, deadline)?;
    write_selected_text(text, |attribute, value| {
        crate::actions::ax_helpers::set_ax_string_or_err(element, attribute, value, deadline)
    })?;
    if deadline.is_expired() {
        return Err(deadline
            .timeout_error()
            .with_details(serde_json::json!({ "operation": "AXSelectedText" }))
            .with_disposition(DeliverySemantics::delivered_unverified()));
    }
    Ok(())
}

fn write_selected_text(
    text: &str,
    write: impl FnOnce(&str, &str) -> Result<(), AdapterError>,
) -> Result<(), AdapterError> {
    write("AXSelectedText", text)
}

fn is_text_target(element: &AXElement, deadline: Deadline) -> Result<bool, AdapterError> {
    prepare(element, deadline)?;
    let result =
        crate::tree::properties::attributes::copy_string_attr_result(element, "AXRole", deadline);
    if deadline.is_expired() {
        return Err(deadline.timeout_error());
    }
    let role = result.map_err(|error| {
        AdapterError::new(
            ErrorCode::ActionFailed,
            "Could not read keyboard target role",
        )
        .with_details(serde_json::json!({ "ax_error": error }))
    })?;
    Ok(matches!(
        role.as_deref(),
        Some("AXTextField" | "AXTextArea" | "AXSecureTextField" | "AXComboBox")
    ))
}

fn prepare(element: &AXElement, deadline: Deadline) -> Result<(), AdapterError> {
    crate::tree::properties::attributes::set_messaging_timeout(element, deadline)
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn execute_type(
    _element: &crate::tree::AXElement,
    _text: &str,
    _policy: agent_desktop_core::InteractionPolicy,
    _deadline: Deadline,
) -> Result<agent_desktop_core::ActionStep, AdapterError> {
    Err(AdapterError::not_supported("type_text"))
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;

    #[test]
    fn type_writes_the_current_selection_instead_of_the_whole_value() {
        let observed = RefCell::new(None);
        super::write_selected_text("inserted", |attribute, value| {
            observed.replace(Some((attribute.to_owned(), value.to_owned())));
            Ok(())
        })
        .unwrap();

        assert_eq!(
            observed.into_inner(),
            Some(("AXSelectedText".into(), "inserted".into()))
        );
    }
}
