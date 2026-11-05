//! WinForms' native BUTTON and EDIT proxies can focus the control when
//! Invoke or Value.SetValue runs. Their direct MSAA paths avoid that step.

use agent_desktop_core::{
    ActionStep, AdapterError, Deadline, DeliverySemantics, ErrorCode, InteractionPolicy,
};
use uiautomation::patterns::UILegacyIAccessiblePattern;

use crate::actions::chain::{ChainDef, ChainRung, DeliveryOutcome, after_delivery, execute_chain};
use crate::actions::mutation::{classify_success, classify_write};
use crate::actions::value_write::gated_pattern_value_equals;
use crate::system::window::window_ops::window_class_name;
use crate::tree::element::UIAElement;
use crate::tree::properties::{property_ids::TreeProperty, read_one};

const LEGACY_VALUE_LABEL: &str = "LegacyIAccessible.SetValue";
const LEGACY_VALUE_CHAIN: ChainDef = ChainDef {
    suggestion: "Refresh the snapshot or choose a writable Windows Forms edit control with a legacy accessibility value.",
    continue_after_unverified_delivery: false,
};

pub(crate) fn headless_winforms_control(
    element: &UIAElement,
    policy: InteractionPolicy,
    expected_class: &str,
) -> bool {
    if policy.is_headed() {
        return false;
    }
    let Ok(handle) = element.0.get_native_window_handle() else {
        return false;
    };
    let hwnd: isize = handle.into();
    window_class_name(hwnd as crate::system::window::window_enum::WindowHandle)
        .is_some_and(|class| matches_native_class(&class, expected_class))
        && element.0.get_framework_id().is_ok_and(|id| id == "WinForm")
}

fn matches_native_class(class: &str, expected_class: &str) -> bool {
    let mut parts = class.splitn(3, '.');
    parts.next() == Some("WindowsForms10")
        && parts.next() == Some(expected_class)
        && parts.next().is_some()
}

pub(crate) fn legacy_edit_steps(
    element: &UIAElement,
    value: &str,
    deadline: Deadline,
    writable: bool,
) -> Result<Vec<ActionStep>, AdapterError> {
    let available =
        writable && read_one(element, TreeProperty::LegacyAvailable).flag() == Some(true);
    legacy_edit_judged_for(deadline, writable, available, || {
        let delivered = match element.0.get_pattern::<UILegacyIAccessiblePattern>() {
            Ok(pattern) => match pattern.set_value(value) {
                Ok(()) => classify_success()?,
                Err(error) => classify_write("SetValue", LEGACY_VALUE_LABEL, &error)?,
            },
            Err(error) => classify_write("get_pattern", LEGACY_VALUE_LABEL, &error)?,
        };
        if !delivered {
            return Ok(DeliveryOutcome::NotDelivered);
        }
        let verified = gated_pattern_value_equals(element, value).map_err(after_delivery)?;
        Ok(DeliveryOutcome::from_observation(verified))
    })
}

fn legacy_edit_judged_for(
    deadline: Deadline,
    writable: bool,
    legacy_available: bool,
    mut write: impl FnMut() -> Result<DeliveryOutcome, AdapterError>,
) -> Result<Vec<ActionStep>, AdapterError> {
    deadline.ensure_remaining()?;
    if !writable {
        return Err(AdapterError::new(
            ErrorCode::ActionFailed,
            "This Windows Forms edit control does not expose a writable Value pattern",
        )
        .with_suggestion("Choose a writable edit control.")
        .with_disposition(DeliverySemantics::not_delivered()));
    }
    if !legacy_available {
        return Err(AdapterError::new(
            ErrorCode::PolicyDenied,
            "This Windows Forms edit control requires a legacy accessibility value for headless writes. ValuePattern.SetValue can move foreground focus.",
        )
        .with_suggestion("Use --headed if foreground activation is acceptable.")
        .with_disposition(DeliverySemantics::not_delivered()));
    }
    execute_chain(
        deadline,
        &LEGACY_VALUE_CHAIN,
        InteractionPolicy::headless(),
        &mut [ChainRung {
            label: LEGACY_VALUE_LABEL,
            requires_headed: false,
            run: &mut write,
        }],
    )
}

#[cfg(test)]
#[path = "winforms_tests.rs"]
mod tests;
