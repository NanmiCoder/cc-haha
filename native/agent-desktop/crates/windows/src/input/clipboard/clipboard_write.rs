//! Clipboard write transaction: EmptyClipboard → multi-format publish → ownership re-check.
//!
//! Marshalling runs before the clipboard is opened so a panic=abort residual
//! between EmptyClipboard and a completed write stays a few straight-line
//! Win32 calls. InteractionLease is not mutual exclusion on Windows; the
//! ownership re-check is the load-bearing delivery guarantee.

use agent_desktop_core::{
    AdapterError, ClipboardContent, Deadline, DeliverySemantics, ErrorCode, ImageBuffer,
};
#[cfg(test)]
use std::sync::atomic::{AtomicBool, Ordering};

use windows_sys::Win32::Foundation::{GetLastError, HWND};
use windows_sys::Win32::System::DataExchange::{
    EmptyClipboard, GetClipboardOwner, GetClipboardSequenceNumber,
};

use super::clipboard_files::encode_hdrop;
use super::clipboard_formats::{CF_DIB, CF_HDROP, CF_UNICODETEXT, registered_png_format};
use super::clipboard_guard::MoveableMemory;
use super::clipboard_image::{encode_dib_from_png, png_bytes_for_clipboard};
use super::clipboard_session::ClipboardSession;
use super::clipboard_text::encode_utf16_text;

#[cfg(test)]
static FORCE_OWNERSHIP_LOSS: AtomicBool = AtomicBool::new(false);

pub(crate) fn set_clipboard_content(
    content: &ClipboardContent,
    deadline: Deadline,
) -> Result<(), AdapterError> {
    deadline.ensure_remaining().map_err(not_delivered)?;
    let prepared = prepare_formats(content, deadline).map_err(not_delivered)?;
    let session = ClipboardSession::open_for_write(deadline)?;
    let owner = ClipboardSession::owner_hwnd()?;
    if unsafe { EmptyClipboard() } == 0 {
        return Err(AdapterError::new(
            ErrorCode::ActionFailed,
            "EmptyClipboard failed before any clipboard format was published",
        )
        .with_platform_detail(format!("GetLastError={}", unsafe { GetLastError() }))
        .with_disposition(DeliverySemantics::not_delivered()));
    }
    let sequence_after_empty = unsafe { GetClipboardSequenceNumber() };
    for (format, bytes) in prepared {
        deadline
            .ensure_remaining()
            .map_err(|error| error.with_disposition(DeliverySemantics::delivered_unverified()))?;
        MoveableMemory::from_bytes(&bytes)
            .map_err(|error| error.with_disposition(DeliverySemantics::delivered_unverified()))?
            .set_clipboard_data(format)?;
    }
    confirm_write_ownership(owner, sequence_after_empty)?;
    drop(session);
    Ok(())
}

pub(crate) fn clear_clipboard(deadline: Deadline) -> Result<(), AdapterError> {
    deadline.ensure_remaining().map_err(not_delivered)?;
    let _session = ClipboardSession::open_for_write(deadline)?;
    if unsafe { EmptyClipboard() } == 0 {
        return Err(
            AdapterError::new(ErrorCode::ActionFailed, "EmptyClipboard failed")
                .with_platform_detail(format!("GetLastError={}", unsafe { GetLastError() }))
                .with_disposition(DeliverySemantics::not_delivered()),
        );
    }
    Ok(())
}

fn prepare_formats(
    content: &ClipboardContent,
    deadline: Deadline,
) -> Result<Vec<(u32, Vec<u8>)>, AdapterError> {
    match content {
        ClipboardContent::Text(text) => Ok(vec![(CF_UNICODETEXT, encode_utf16_text(text)?)]),
        ClipboardContent::Image(image) => prepare_image_formats(image, deadline),
        ClipboardContent::FileUrls(paths) => Ok(vec![(CF_HDROP, encode_hdrop(paths)?)]),
    }
}

fn prepare_image_formats(
    image: &ImageBuffer,
    deadline: Deadline,
) -> Result<Vec<(u32, Vec<u8>)>, AdapterError> {
    let png = png_bytes_for_clipboard(image)?;
    let dib = encode_dib_from_png(&png, deadline)?;
    let mut formats = Vec::with_capacity(2);
    if let Some(png_format) = registered_png_format() {
        formats.push((png_format, png));
    }
    formats.push((CF_DIB, dib));
    Ok(formats)
}

fn confirm_write_ownership(owner: HWND, sequence_after_empty: u32) -> Result<(), AdapterError> {
    #[cfg(test)]
    if FORCE_OWNERSHIP_LOSS.load(Ordering::SeqCst) {
        return Err(delivered_unverified(
            "test injected ownership loss after EmptyClipboard",
        ));
    }
    let current_owner = unsafe { GetClipboardOwner() };
    let sequence = unsafe { GetClipboardSequenceNumber() };
    if current_owner == owner && sequence >= sequence_after_empty {
        return Ok(());
    }
    Err(delivered_unverified(&format!(
        "GetClipboardOwner=0x{:X} expected=0x{:X} sequence={sequence} sequence_after_empty={sequence_after_empty}",
        current_owner as usize, owner as usize
    )))
}

fn delivered_unverified(reason: &str) -> AdapterError {
    AdapterError::new(
        ErrorCode::AppUnresponsive,
        "Clipboard write delivery could not be verified",
    )
    .with_platform_detail(reason)
    .with_suggestion("Inspect the clipboard state before deciding whether to repeat the write")
    .with_disposition(DeliverySemantics::delivered_unverified())
}

fn not_delivered(error: AdapterError) -> AdapterError {
    error.with_disposition(DeliverySemantics::not_delivered())
}

#[cfg(test)]
pub(crate) fn force_ownership_loss_for_test(force: bool) {
    FORCE_OWNERSHIP_LOSS.store(force, Ordering::SeqCst);
}

#[cfg(test)]
#[path = "clipboard_write_tests.rs"]
mod tests;
