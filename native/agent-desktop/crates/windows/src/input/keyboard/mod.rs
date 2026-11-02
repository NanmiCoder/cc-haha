//! `InputOps::key_event` and the keyboard-synthesis primitives it composes
//! with: modifier chords (`keyboard_event`) and chunked UTF-16 text
//! (`keyboard_text`). A standalone key edge has no daemon to own the hold
//! across a request boundary, so it rejects the same way macOS's
//! `reject_standalone_key_state` does - the atomic `press`/`type`
//! composers that call `synthesize_key`/`synthesize_text` under a focus
//! verify belong to the `execute_action` physical legs wired in
//! `actions/physical_keyboard`.

use agent_desktop_core::{AdapterError, Deadline, ErrorCode, KeyCombo};

/// The chord primitive: press modifiers, press/release the key, release
/// modifiers, under a release guard. It carries no policy and no focus
/// check by design - `actions/physical_keyboard` composes it with the
/// policy gate and the focus verify - so the primitive stays usable by any
/// caller that has already established those.
pub(crate) fn synthesize_key(combo: &KeyCombo, deadline: Deadline) -> Result<(), AdapterError> {
    crate::input::keyboard::keyboard_event::synthesize_key(combo, deadline)
}

/// The chunked UTF-16 `type_text` primitive, kept policy-free the same way
/// `synthesize_key` is. The physical `type` leg supplies the per-chunk
/// verifier that re-checks focus between chunks.
pub(crate) fn synthesize_text(
    text: &str,
    deadline: Deadline,
    verify_target: impl FnMut(Deadline) -> Result<(), AdapterError>,
) -> Result<(), AdapterError> {
    crate::input::keyboard::keyboard_text::synthesize_text(text, deadline, verify_target)
}

/// Deadline preflight for `synthesize_text`, callable independently so a
/// composing leg can reject before establishing focus.
pub(crate) fn preflight_text(text: &str, deadline: Deadline) -> Result<(), AdapterError> {
    crate::input::keyboard::keyboard_text::preflight_text(text, deadline).map(|_| ())
}

pub(crate) fn reject_standalone_key_state(
    _combo: &KeyCombo,
    _down: bool,
) -> Result<(), AdapterError> {
    Err(AdapterError::new(
        ErrorCode::ActionNotSupported,
        "Standalone key-down/key-up is unavailable in stateless mode",
    )
    .with_details(serde_json::json!({
        "raw_input_emitted": false,
        "requires_daemon_owned_transaction": true,
    }))
    .with_suggestion(
        "Use the atomic 'press' command; spanning key holds require a daemon-owned session that can release keys after disconnect",
    )
    .with_disposition(agent_desktop_core::DeliverySemantics::not_delivered()))
}

pub(super) mod keyboard_event;
pub(super) mod keyboard_map;
pub(super) mod keyboard_send;
pub(super) mod keyboard_text;
#[cfg(test)]
#[path = "keyboard_tests.rs"]
mod tests;
