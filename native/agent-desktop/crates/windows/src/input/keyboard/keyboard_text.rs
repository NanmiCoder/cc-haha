//! UTF-16 `type_text` chunking and Unicode `SendInput` synthesis.
//!
//! The chunk boundary (<=32 UTF-16 units, never splitting a surrogate) is
//! ported from `crates/macos/src/input/keyboard/keyboard_event.rs` verbatim - nothing
//! about `SendInput` forces this size, but it bounds each chunk against the
//! deadline and gives per-chunk delivery accounting. Each chunk becomes one
//! `SendInput` batch of `KEYEVENTF_UNICODE` down/up pairs, one pair per code
//! unit (a surrogate pair is two pairs) - the A4-1 measured per-event
//! contract. A CR LF pair is posted as its CR alone: each Unicode CR or LF
//! is a line break on its own, so posting both would type two. No arm of
//! this module ever places the typed text itself into an error: only chunk
//! counts survive into `details`.

use std::time::Duration;

use agent_desktop_core::{AdapterError, Deadline, DeliverySemantics, ErrorCode};

use crate::input::keyboard::keyboard_send::{KeyboardInputEvent, post_keyboard_inputs};

const TEXT_CHUNK_UTF16: usize = 32;
const MAX_TEXT_UTF16: usize = 1_000_000;
const TEXT_CHUNK_BUDGET: Duration = Duration::from_millis(400);
const KEYEVENTF_UNICODE: u32 = 0x0004;
const KEYEVENTF_KEYUP: u32 = 0x0002;

#[cfg(target_os = "windows")]
const _: () = {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse as win32;
    assert!(KEYEVENTF_UNICODE == win32::KEYEVENTF_UNICODE);
    assert!(KEYEVENTF_KEYUP == win32::KEYEVENTF_KEYUP);
};

pub(crate) fn synthesize_text(
    text: &str,
    deadline: Deadline,
    mut verify_target: impl FnMut(Deadline) -> Result<(), AdapterError>,
) -> Result<(), AdapterError> {
    let chunk_count = preflight_text(text, deadline)?;
    let chunks = text_chunks(text, Some(chunk_count))?;
    let total = chunks.len();
    for (delivered_chunks, chunk) in chunks.into_iter().enumerate() {
        ensure_chunk_budget(deadline, total, delivered_chunks)?;
        verify_target(deadline).map_err(|error| {
            let disposition = if delivered_chunks == 0 {
                DeliverySemantics::not_delivered()
            } else {
                DeliverySemantics::delivered_unverified()
            };
            error
                .with_details(serde_json::json!({
                    "delivered_chunks": delivered_chunks,
                    "total_chunks": total,
                }))
                .with_disposition(disposition)
        })?;
        post_keyboard_inputs(&chunk_events(&chunk));
    }
    Ok(())
}

pub(crate) fn preflight_text(text: &str, deadline: Deadline) -> Result<usize, AdapterError> {
    let chunks = planned_chunk_count(text)?;
    let multiplier = u32::try_from(chunks).map_err(|_| text_too_large())?;
    let required = TEXT_CHUNK_BUDGET
        .checked_mul(multiplier)
        .ok_or_else(text_too_large)?;
    let remaining = deadline.remaining();
    if remaining < required {
        return Err(AdapterError::timeout(
            "Text cannot be delivered safely within the remaining deadline",
        )
        .with_details(serde_json::json!({
            "delivered_chunks": 0,
            "total_chunks": chunks,
            "required_ms": required.as_millis(),
            "remaining_ms": remaining.as_millis(),
        }))
        .with_disposition(DeliverySemantics::not_delivered()));
    }
    Ok(chunks)
}

pub(crate) fn ensure_chunk_budget(
    deadline: Deadline,
    total: usize,
    delivered_chunks: usize,
) -> Result<(), AdapterError> {
    deadline.ensure_remaining().map_err(|error| {
        let disposition = if delivered_chunks == 0 {
            DeliverySemantics::not_delivered()
        } else {
            DeliverySemantics::delivered_unverified()
        };
        error
            .with_details(serde_json::json!({
                "delivered_chunks": delivered_chunks,
                "total_chunks": total,
            }))
            .with_disposition(disposition)
    })
}

fn chunk_events(chunk: &[u16]) -> Vec<KeyboardInputEvent> {
    let mut events = Vec::with_capacity(chunk.len() * 2);
    for &unit in chunk {
        events.push(KeyboardInputEvent {
            vk: 0,
            scan: unit,
            flags: KEYEVENTF_UNICODE,
        });
        events.push(KeyboardInputEvent {
            vk: 0,
            scan: unit,
            flags: KEYEVENTF_UNICODE | KEYEVENTF_KEYUP,
        });
    }
    events
}

fn text_chunks(
    text: &str,
    known_chunk_count: Option<usize>,
) -> Result<Vec<Vec<u16>>, AdapterError> {
    let _ = match known_chunk_count {
        Some(count) => count,
        None => planned_chunk_count(text)?,
    };
    let mut chunks = Vec::new();
    let mut current = Vec::with_capacity(TEXT_CHUNK_UTF16);
    for character in typed_chars(text) {
        let mut encoded = [0_u16; 2];
        let encoded = character.encode_utf16(&mut encoded);
        if !current.is_empty() && current.len() + encoded.len() > TEXT_CHUNK_UTF16 {
            chunks.push(std::mem::take(&mut current));
        }
        current.extend_from_slice(encoded);
    }
    if !current.is_empty() {
        chunks.push(current);
    }
    Ok(chunks)
}

fn planned_chunk_count(text: &str) -> Result<usize, AdapterError> {
    let mut units = 0_usize;
    let mut chunks = 0_usize;
    let mut current = 0_usize;
    for character in typed_chars(text) {
        let encoded = character.len_utf16();
        units = units.checked_add(encoded).ok_or_else(text_too_large)?;
        if units > MAX_TEXT_UTF16 {
            return Err(text_too_large());
        }
        if current > 0 && current + encoded > TEXT_CHUNK_UTF16 {
            chunks += 1;
            current = 0;
        }
        current += encoded;
    }
    Ok(chunks + usize::from(current > 0))
}

/// The characters posted for `text`: every character except the LF of a
/// CR LF pair.
fn typed_chars(text: &str) -> impl Iterator<Item = char> + '_ {
    let mut previous = None;
    text.chars().filter(move |&character| {
        let skip = character == '\n' && previous == Some('\r');
        previous = Some(character);
        !skip
    })
}

fn text_too_large() -> AdapterError {
    AdapterError::new(
        ErrorCode::InvalidArgs,
        "Text input must not exceed 1000000 UTF-16 code units",
    )
}

#[cfg(all(test, target_os = "windows"))]
#[path = "keyboard_text_tests.rs"]
mod tests;
