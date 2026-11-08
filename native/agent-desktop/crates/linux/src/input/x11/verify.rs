use agent_desktop_core::{AdapterError, DeliverySemantics, ErrorCode};
use serde_json::json;
use std::thread;
use std::time::Duration;

use super::pointer_read::PointerRead;

use super::sink_error::SinkError;

use super::sink::X11Sink;
use crate::input::held_input::HeldInput;

const FIRST_BUTTON_MASK: u16 = 0x0100;
const INPUT_SETTLE_LIMIT: Duration = Duration::from_millis(250);
const INPUT_SETTLE_POLL: Duration = Duration::from_millis(10);

pub(crate) fn leftover_buttons(read: &PointerRead, pressed: &[u8]) -> Vec<u8> {
    pressed
        .iter()
        .copied()
        .filter(|code| {
            let bit = FIRST_BUTTON_MASK.checked_shl(u32::from(code.saturating_sub(1)));
            bit.is_some_and(|bit| read.mask & bit != 0)
        })
        .collect()
}

pub(crate) fn leftover_keys(bits: &[u8; 32], pressed: &[u8]) -> Vec<u8> {
    pressed
        .iter()
        .copied()
        .filter(|code| bits[usize::from(*code / 8)] & (1 << (code % 8)) != 0)
        .collect()
}

pub(crate) fn check(
    sink: &mut dyn X11Sink,
    touched: &HeldInput,
    deadline: agent_desktop_core::Deadline,
) -> Result<(), AdapterError> {
    let HeldInput { buttons, keys } = observe_leftovers(sink, touched, deadline)?;
    if buttons.is_empty() && keys.is_empty() {
        return Ok(());
    }
    for code in &buttons {
        let _ = sink.button(*code, false);
    }
    for code in &keys {
        let _ = sink.key(*code, false);
    }
    let _ = sink.round_trip();
    Err(AdapterError::new(
        ErrorCode::ActionFailed,
        "Input was still held after the call finished",
    )
    .with_details(json!({ "leftover_buttons": buttons, "leftover_keys": keys }))
    .with_suggestion("Run 'snapshot' to read the real state before retrying")
    .with_disposition(DeliverySemantics::delivered_unverified()))
}

fn observe_leftovers(
    sink: &mut dyn X11Sink,
    touched: &HeldInput,
    deadline: agent_desktop_core::Deadline,
) -> Result<HeldInput, AdapterError> {
    let settle = deadline.capped(INPUT_SETTLE_LIMIT);
    loop {
        let buttons = if touched.buttons.is_empty() {
            Vec::new()
        } else {
            let read = sink.pointer().map_err(SinkError::into_adapter)?;
            leftover_buttons(&read, &touched.buttons)
        };
        let keys = if touched.keys.is_empty() {
            Vec::new()
        } else {
            let bits = sink.keys_down().map_err(SinkError::into_adapter)?;
            leftover_keys(&bits, &touched.keys)
        };
        if (buttons.is_empty() && keys.is_empty()) || settle.is_expired() {
            return Ok(HeldInput { buttons, keys });
        }
        thread::sleep(settle.remaining().min(INPUT_SETTLE_POLL));
    }
}

#[cfg(test)]
#[path = "verify_tests.rs"]
mod tests;
