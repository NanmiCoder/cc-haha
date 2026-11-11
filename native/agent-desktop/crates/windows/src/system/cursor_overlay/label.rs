//! What the card is allowed to say, bounded where an unvetted sender can
//! reach it.
//!
//! A label arriving over the pipe has passed only the transport's frame cap,
//! which is thousands of bytes. The configuration's own ceilings are applied
//! by the process that builds the control, and any process on this desktop
//! running as this user can build one - so a caption long enough to cover the
//! screen is reachable without touching the configuration at all. The
//! ceilings are therefore applied again on the reading side.
//!
//! The ceilings themselves come from core, so the reading side and the sending
//! side cannot drift to two different numbers: a renderer holding its own copy
//! would keep cutting at the old ceiling after the configuration's moved, and
//! nothing would report the disagreement.
//!
//! They are applied here rather than in the control's own validation because
//! a label reaches that validation from the action path too, on every
//! platform. Refusing an over-long caption there would fail an enable that a
//! renderer could have drawn perfectly well once it was cut down, which is a
//! rendering decision answered with an error.

use agent_desktop_core::{MAX_CURSOR_LABEL_BYTES, MAX_CURSOR_LABEL_WORDS};

/// The label as the card may show it, or nothing when it says nothing.
///
/// The ellipsis marks the cut for the same reason the configuration's does: a
/// caption that simply stops reads as a caption the agent wrote badly.
pub(crate) fn clamp(label: &str) -> Option<String> {
    let words: Vec<&str> = within_byte_ceiling(label.trim())
        .split_whitespace()
        .collect();
    if words.is_empty() {
        return None;
    }
    if words.len() <= MAX_CURSOR_LABEL_WORDS {
        return Some(words.join(" "));
    }
    let mut limited = words[..MAX_CURSOR_LABEL_WORDS].join(" ");
    limited.push('…');
    Some(limited)
}

/// Cuts at the last character boundary at or before the ceiling. Cutting on
/// the byte alone would split a multi-byte character and panic the renderer on
/// a caption it was only ever asked to shorten.
fn within_byte_ceiling(value: &str) -> &str {
    if value.len() <= MAX_CURSOR_LABEL_BYTES {
        return value;
    }
    let mut end = MAX_CURSOR_LABEL_BYTES;
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    value.get(..end).unwrap_or_default()
}

#[cfg(test)]
#[path = "label_tests.rs"]
mod tests;
