//! The control wire format and the single acknowledgement byte.
//!
//! Pure, and deliberately the same shape macOS uses: one JSON-encoded
//! `CursorOverlayControl` per connection under a size cap, answered by one
//! byte. The cap matters because the payload arrives from another process and
//! a framing that grows with its input is a framing an unbounded write can
//! stall.
//!
//! Which controls are acknowledged is part of the contract rather than an
//! implementation detail: the caller of a travel, a hide or a disable blocks
//! on the answer, and so does the caller of the enable that decides
//! `data.rendered`. An effect control is fire-and-forget after dispatch has
//! already confirmed, so waiting on it would add latency to nothing.

use agent_desktop_core::{AdapterError, CursorOverlayControl, ErrorCode};

/// Matches the macOS transport's cap. A control is coordinates, a short label
/// and a style; nothing legitimate approaches this.
pub(crate) const MAX_CONTROL_BYTES: usize = 4096;

pub(crate) const ACKNOWLEDGEMENT: u8 = 1;

pub(crate) fn encode(control: &CursorOverlayControl) -> Result<Vec<u8>, AdapterError> {
    let bytes = serde_json::to_vec(control).map_err(|error| {
        AdapterError::internal("The cursor overlay control could not be encoded")
            .with_platform_detail(error.to_string())
    })?;
    if bytes.len() > MAX_CONTROL_BYTES {
        return Err(AdapterError::new(
            ErrorCode::InvalidArgs,
            "The cursor overlay control is larger than the transport accepts",
        )
        .with_platform_detail(format!(
            "{} bytes encoded, {MAX_CONTROL_BYTES} accepted",
            bytes.len()
        )));
    }
    Ok(bytes)
}

pub(crate) fn decode(bytes: &[u8]) -> Result<CursorOverlayControl, AdapterError> {
    if bytes.len() > MAX_CONTROL_BYTES {
        return Err(AdapterError::new(
            ErrorCode::InvalidArgs,
            "The cursor overlay control is larger than the transport accepts",
        ));
    }
    serde_json::from_slice(bytes).map_err(|error| {
        AdapterError::new(
            ErrorCode::InvalidArgs,
            "The cursor overlay control could not be decoded",
        )
        .with_platform_detail(error.to_string())
    })
}

/// Whether the sender of this control waits for the byte the renderer sends
/// back.
///
/// An `Enable` is included and macOS's send path does not include it. That is
/// a deliberate divergence: `data.rendered` is answered from this
/// acknowledgement, and the bootstrap that starts the child is a one-way
/// stdin write with no return path of its own.
pub(crate) fn is_acknowledged(control: &CursorOverlayControl) -> bool {
    control.is_enable() || control.is_disable() || control.is_hide() || control.is_travel()
}

/// Whether a control may bring a renderer into existence when none is
/// running. A `Disable` that spawned one would start a renderer in order to
/// tell it to stop, and `Hide`/`Show` are sent around every mutating command
/// in a headed session — which would fork one per command.
pub(crate) fn may_spawn(control: &CursorOverlayControl) -> bool {
    control.is_enable() || control.instruction().is_some()
}

#[cfg(test)]
#[path = "framing_tests.rs"]
mod tests;
