use agent_desktop_core::{AdapterError, DeliverySemantics, ErrorCode};
use serde_json::json;

use crate::input::keyboard::keysym_step::KeysymStep;

const PRINTABLE_ASCII: std::ops::RangeInclusive<u32> = 0x20..=0x7e;
const FUNCTION_KEYS: std::ops::RangeInclusive<u32> = 0xfe00..=0xffff;
const FIRST_VENDOR_KEYSYM: u32 = 0x1008_ff00;

/// Whether the compositor's keysym route can produce `keysym` on the session
/// keymap. Measured on a US layout: printable ASCII at either shift level and
/// the function and modifier keys are delivered, while Latin-1 letters, the
/// euro sign and Unicode-form keysyms are accepted by the call and then
/// dropped without an event.
pub(crate) fn reachable(keysym: u32) -> bool {
    PRINTABLE_ASCII.contains(&keysym)
        || FUNCTION_KEYS.contains(&keysym)
        || keysym >= FIRST_VENDOR_KEYSYM
}

pub(crate) fn refuse_unreachable(keys: &[KeysymStep]) -> Result<(), AdapterError> {
    if keys.iter().all(|key| reachable(key.keysym)) {
        return Ok(());
    }
    Err(AdapterError::new(
        ErrorCode::ActionNotSupported,
        "A character in the text is outside the layout of the Wayland session keyboard",
    )
    .with_suggestion("Use the semantic set-value on the element instead of typing the text")
    .with_details(json!({
        "physical_delivery_started": false,
        "cause": "character_outside_layout",
    }))
    .with_disposition(DeliverySemantics::not_delivered()))
}

#[cfg(test)]
#[path = "layout_tests.rs"]
mod tests;
