use agent_desktop_core::{AdapterError, Deadline, ErrorCode, KeyCombo, Modifier};
use std::collections::VecDeque;
use std::time::Instant;

use super::{element_attribute, read_error};
use crate::tree::AXElement;

const MAX_MENU_NODES: usize = 2_048;
const MAX_MENU_CHILDREN: usize = 128;
const MAX_MENU_DEPTH: u8 = 8;
const AX_MENU_MODIFIER_SHIFT: u32 = 1 << 0;
const AX_MENU_MODIFIER_OPTION: u32 = 1 << 1;
const AX_MENU_MODIFIER_CONTROL: u32 = 1 << 2;
const AX_MENU_MODIFIER_NO_COMMAND: u32 = 1 << 3;

pub(super) fn try_menu_bar_shortcut(
    app: &AXElement,
    combo: &KeyCombo,
    deadline: Deadline,
) -> Result<bool, AdapterError> {
    let Some(target_char) = single_uppercase_character(&combo.key) else {
        return Ok(false);
    };
    let Some(menu_bar) = element_attribute(app, "AXMenuBar", deadline)? else {
        return Ok(false);
    };
    let target_modifiers = combo_to_ax_modifiers(combo);
    let mut queue = VecDeque::from([(menu_bar, 0_u8)]);
    let mut visited = 0_usize;

    while let Some((element, depth)) = queue.pop_front() {
        deadline.ensure_remaining()?;
        visited += 1;
        if visited > MAX_MENU_NODES {
            return Err(incomplete_menu_error("node_limit"));
        }
        if read_string(&element, "AXMenuItemCmdChar", deadline)?
            .is_some_and(|value| value.to_uppercase() == target_char)
            && read_menu_item_modifiers(&element, deadline)? == Some(target_modifiers)
        {
            return crate::actions::ax_helpers::try_ax_action_or_err(&element, "AXPress", deadline);
        }
        if depth >= MAX_MENU_DEPTH {
            if has_children(&element, deadline)? {
                return Err(incomplete_menu_error("depth_limit"));
            }
            continue;
        }
        let children = children(&element, deadline)?;
        queue.extend(
            children
                .into_iter()
                .map(|child| (child, depth.saturating_add(1))),
        );
    }
    Ok(false)
}

fn children(element: &AXElement, deadline: Deadline) -> Result<Vec<AXElement>, AdapterError> {
    let read = crate::tree::query::child_read::read_attribute_children(
        element,
        "AXChildren",
        MAX_MENU_CHILDREN,
        instant(deadline)?,
    );
    deadline.ensure_remaining()?;
    validate_menu_children(read)
}

fn has_children(element: &AXElement, deadline: Deadline) -> Result<bool, AdapterError> {
    let read = crate::tree::query::child_read::read_attribute_children(
        element,
        "AXChildren",
        0,
        instant(deadline)?,
    );
    deadline.ensure_remaining()?;
    validate_child_status(&read)?;
    Ok(read.total_count > 0)
}

fn validate_menu_children(
    read: crate::tree::query::child_read::ChildRead,
) -> Result<Vec<AXElement>, AdapterError> {
    validate_child_status(&read)?;
    if !read.complete || read.truncated() {
        return Err(
            incomplete_menu_error("child_limit").with_details(serde_json::json!({
                "kind": "child_limit",
                "complete": false,
                "total_count": read.total_count,
                "loaded_count": read.elements.len(),
            })),
        );
    }
    Ok(read.elements)
}

fn validate_child_status(
    read: &crate::tree::query::child_read::ChildRead,
) -> Result<(), AdapterError> {
    if read.status.api_disabled {
        return Err(read_error(
            "AXChildren",
            accessibility_sys::kAXErrorAPIDisabled,
        ));
    }
    if read.status.invalid_element {
        return Err(read_error(
            "AXChildren",
            accessibility_sys::kAXErrorInvalidUIElement,
        ));
    }
    if read.status.health.cannot_complete > 0 || read.status.health.deadline_exhausted > 0 {
        return Err(read_error(
            "AXChildren",
            accessibility_sys::kAXErrorCannotComplete,
        ));
    }
    Ok(())
}

fn read_string(
    element: &AXElement,
    attribute: &str,
    deadline: Deadline,
) -> Result<Option<String>, AdapterError> {
    let result =
        crate::tree::properties::attributes::copy_string_attr_result(element, attribute, deadline);
    deadline.ensure_remaining()?;
    result.map_err(|error| read_error(attribute, error))
}

fn read_menu_item_modifiers(
    element: &AXElement,
    deadline: Deadline,
) -> Result<Option<u32>, AdapterError> {
    use accessibility_sys::kAXErrorSuccess;
    use core_foundation::{base::TCFType, string::CFString};

    let attribute = CFString::new("AXMenuItemCmdModifiers");
    let (error, value) = crate::tree::properties::ax_ipc::copy_attribute_value(
        element,
        attribute.as_concrete_TypeRef(),
        deadline,
    );
    deadline.ensure_remaining()?;
    if error != kAXErrorSuccess {
        return if error == accessibility_sys::kAXErrorNoValue
            || error == accessibility_sys::kAXErrorAttributeUnsupported
        {
            Ok(None)
        } else {
            Err(read_error("AXMenuItemCmdModifiers", error))
        };
    }
    if value.is_null() {
        return Err(malformed_menu_modifiers());
    }
    let value = unsafe { core_foundation::base::CFType::wrap_under_create_rule(value) };
    let number = crate::tree::properties::cf_type::borrowed_cf_number(value.as_concrete_TypeRef())
        .and_then(|number| number.to_i64())
        .ok_or_else(malformed_menu_modifiers)?;
    normalize_menu_modifiers(number).map(Some)
}

fn single_uppercase_character(key: &str) -> Option<String> {
    if let Some(symbol) = crate::input::keyboard::keyboard_map::punctuation(key) {
        return Some(symbol.to_string());
    }
    (key.chars().count() == 1).then(|| key.to_uppercase())
}

fn combo_to_ax_modifiers(combo: &KeyCombo) -> u32 {
    let mut encoded = if combo.modifiers.contains(&Modifier::Meta) {
        0
    } else {
        AX_MENU_MODIFIER_NO_COMMAND
    };
    encoded |= combo.modifiers.iter().fold(0, |modifiers, modifier| {
        modifiers
            | match modifier {
                Modifier::Shift => AX_MENU_MODIFIER_SHIFT,
                Modifier::Alt => AX_MENU_MODIFIER_OPTION,
                Modifier::Ctrl => AX_MENU_MODIFIER_CONTROL,
                Modifier::Meta => 0,
            }
    });
    encoded
}

fn normalize_menu_modifiers(number: i64) -> Result<u32, AdapterError> {
    let value = u32::try_from(number).map_err(|_| malformed_menu_modifiers())?;
    let supported = AX_MENU_MODIFIER_SHIFT
        | AX_MENU_MODIFIER_OPTION
        | AX_MENU_MODIFIER_CONTROL
        | AX_MENU_MODIFIER_NO_COMMAND;
    if value & !supported != 0 {
        return Err(malformed_menu_modifiers());
    }
    Ok(value)
}

fn malformed_menu_modifiers() -> AdapterError {
    AdapterError::new(
        ErrorCode::AppUnresponsive,
        "AXMenuItemCmdModifiers had an invalid value",
    )
    .with_details(serde_json::json!({
        "kind": "menu_modifier_value_invalid",
        "complete": false,
    }))
}

fn instant(deadline: Deadline) -> Result<Instant, AdapterError> {
    Instant::now()
        .checked_add(deadline.remaining())
        .ok_or_else(|| AdapterError::new(ErrorCode::InvalidArgs, "Deadline is out of range"))
}

pub(super) fn is_bounded_menu_incomplete(error: &AdapterError) -> bool {
    error.code == ErrorCode::AppUnresponsive
        && error
            .details
            .as_ref()
            .and_then(|details| details.get("kind"))
            .and_then(serde_json::Value::as_str)
            .is_some_and(|kind| matches!(kind, "node_limit" | "child_limit" | "depth_limit"))
}

fn incomplete_menu_error(kind: &str) -> AdapterError {
    AdapterError::new(
        ErrorCode::AppUnresponsive,
        "Menu shortcut lookup exceeded its bounded accessibility search",
    )
    .with_details(serde_json::json!({ "kind": kind, "complete": false }))
}

#[cfg(test)]
#[path = "key_dispatch_menu_tests.rs"]
mod tests;
