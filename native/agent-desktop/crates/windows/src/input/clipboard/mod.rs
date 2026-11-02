//! Windows clipboard get/set/clear entry points and Auto format resolution.
//!
//! Delay-rendered `GetClipboardData` is unbounded (A22-3), so payload reads of
//! formats that can trigger `WM_RENDERFORMAT` run on a worker the deadline may
//! abandon. A hung owner is refused first via `window_is_responsive` on
//! `GetClipboardOwner`, skipping the probe when the owner is NULL.

use agent_desktop_core::{
    AdapterError, ClipboardContent, ClipboardFormat, Deadline, DeliverySemantics, ErrorCode,
    MAX_PNG_INPUT_BYTES,
};
#[cfg(test)]
use std::cell::Cell;
#[cfg(test)]
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc::{RecvTimeoutError, channel};
use std::thread;

use windows_sys::Win32::Foundation::HANDLE;
use windows_sys::Win32::System::DataExchange::{
    GetClipboardData, GetClipboardOwner, GetClipboardSequenceNumber, IsClipboardFormatAvailable,
};
use windows_sys::Win32::System::Memory::{GlobalLock, GlobalSize, GlobalUnlock};

use super::clipboard::clipboard_files::decode_hdrop;
use super::clipboard::clipboard_formats::{
    CF_DIB, CF_DIBV5, CF_HDROP, CF_UNICODETEXT, registered_png_format,
};
use super::clipboard::clipboard_image::{decode_dib_clipboard, decode_png_clipboard};
use super::clipboard::clipboard_session::ClipboardSession;
use super::clipboard::clipboard_text::decode_utf16_text;
use super::clipboard::clipboard_write::{
    clear_clipboard as clear_clipboard_write, set_clipboard_content,
};
use crate::system::window::window_enum::window_is_responsive;

pub(crate) const MAX_CLIPBOARD_PAYLOAD_BYTES: usize = MAX_PNG_INPUT_BYTES;
const SEQUENCE_RETRY_ATTEMPTS: u32 = 2;

#[cfg(test)]
static SEQUENCE_RETRY_OBSERVED: AtomicU32 = AtomicU32::new(0);
#[cfg(test)]
static INJECT_SEQUENCE_MISMATCH_ONCE: AtomicBool = AtomicBool::new(false);
#[cfg(test)]
thread_local! {
    static GLOBAL_SIZE_OVERRIDE_BYTES: Cell<usize> = const { Cell::new(0) };
}

pub(crate) fn get_clipboard_content(
    format: ClipboardFormat,
    deadline: Deadline,
) -> Result<Option<ClipboardContent>, AdapterError> {
    deadline.ensure_remaining().map_err(not_delivered)?;
    crate::input::clipboard::clipboard_worker_state::ensure_no_outstanding_worker()?;
    for attempt in 0..SEQUENCE_RETRY_ATTEMPTS {
        deadline.ensure_remaining().map_err(not_delivered)?;
        let before = unsafe { GetClipboardSequenceNumber() };
        ensure_owner_responsive()?;
        let content = read_requested(format, deadline)?;
        let after = unsafe { GetClipboardSequenceNumber() };
        let injected_mismatch = sequence_mismatch_injected();
        if before == after && !injected_mismatch {
            return Ok(content);
        }
        #[cfg(test)]
        {
            SEQUENCE_RETRY_OBSERVED.fetch_add(1, Ordering::SeqCst);
        }
        if attempt + 1 == SEQUENCE_RETRY_ATTEMPTS {
            break;
        }
    }
    Err(deadline
        .timeout_error()
        .with_platform_detail("GetClipboardSequenceNumber changed on every stable-read attempt")
        .with_disposition(DeliverySemantics::not_delivered()))
}

pub(crate) fn set_content(
    content: &ClipboardContent,
    deadline: Deadline,
) -> Result<(), AdapterError> {
    crate::input::clipboard::clipboard_worker_state::ensure_no_outstanding_worker()?;
    set_clipboard_content(content, deadline)
}

pub(crate) fn clear(deadline: Deadline) -> Result<(), AdapterError> {
    crate::input::clipboard::clipboard_worker_state::ensure_no_outstanding_worker()?;
    clear_clipboard_write(deadline)
}

fn read_requested(
    format: ClipboardFormat,
    deadline: Deadline,
) -> Result<Option<ClipboardContent>, AdapterError> {
    match format {
        ClipboardFormat::Text => read_text(deadline),
        ClipboardFormat::Image => read_image(deadline),
        ClipboardFormat::FileUrls => read_files(deadline),
        ClipboardFormat::Auto => {
            if let Some(files) = read_files(deadline)? {
                return Ok(Some(files));
            }
            if let Some(image) = read_image(deadline)? {
                return Ok(Some(image));
            }
            read_text(deadline)
        }
    }
}

fn read_text(deadline: Deadline) -> Result<Option<ClipboardContent>, AdapterError> {
    if !format_available(CF_UNICODETEXT) {
        return Ok(None);
    }
    let Some(payload) = read_format_bytes(CF_UNICODETEXT, deadline)? else {
        return Ok(None);
    };
    Ok(Some(ClipboardContent::Text(decode_utf16_text(&payload)?)))
}

fn read_files(deadline: Deadline) -> Result<Option<ClipboardContent>, AdapterError> {
    if !format_available(CF_HDROP) {
        return Ok(None);
    }
    let Some(payload) = read_format_bytes(CF_HDROP, deadline)? else {
        return Ok(None);
    };
    let paths = decode_hdrop(&payload)?;
    Ok((!paths.is_empty()).then_some(ClipboardContent::FileUrls(paths)))
}

fn read_dib_image(
    format: u32,
    deadline: Deadline,
) -> Result<Option<ClipboardContent>, AdapterError> {
    if !format_available(format) {
        return Ok(None);
    }
    let Some(payload) = read_format_bytes(format, deadline)? else {
        return Ok(None);
    };
    Ok(Some(ClipboardContent::Image(decode_dib_clipboard(
        &payload, deadline,
    )?)))
}

fn read_image(deadline: Deadline) -> Result<Option<ClipboardContent>, AdapterError> {
    if let Some(png_format) = registered_png_format() {
        if format_available(png_format) {
            if let Some(payload) = read_format_bytes(png_format, deadline)? {
                return Ok(Some(ClipboardContent::Image(decode_png_clipboard(
                    &payload,
                )?)));
            }
        }
    }
    if let Some(image) = read_dib_image(CF_DIBV5, deadline)? {
        return Ok(Some(image));
    }
    read_dib_image(CF_DIB, deadline)
}

fn format_available(format: u32) -> bool {
    unsafe { IsClipboardFormatAvailable(format) != 0 }
}

/// Whether the clipboard owner is dispatching messages at all.
///
/// This rules out a fully hung message pump. It does **not** rule out a
/// responsive-but-slow renderer, which passes this probe and then blocks
/// inside `GetClipboardData` for as long as it likes - the condition
/// `clipboard_worker_state` exists to detect after the fact.
pub(crate) fn ensure_owner_responsive() -> Result<(), AdapterError> {
    let owner = unsafe { GetClipboardOwner() };
    if owner.is_null() {
        return Ok(());
    }
    if let Ok(ours) = ClipboardSession::owner_hwnd() {
        if owner == ours {
            return Ok(());
        }
    }
    if window_is_responsive(owner) {
        return Ok(());
    }
    Err(AdapterError::new(
        ErrorCode::AppUnresponsive,
        "Clipboard owner is not processing messages, so GetClipboardData would block",
    )
    .with_suggestion("Wait for the application to recover, then retry the clipboard read")
    .with_platform_detail(format!("GetClipboardOwner HWND 0x{:X}", owner as usize))
    .with_disposition(DeliverySemantics::not_delivered()))
}

pub(crate) fn read_format_bytes(
    format: u32,
    deadline: Deadline,
) -> Result<Option<Vec<u8>>, AdapterError> {
    deadline.ensure_remaining().map_err(not_delivered)?;
    crate::input::clipboard::clipboard_worker_state::ensure_no_outstanding_worker()?;
    let owner = unsafe { GetClipboardOwner() };
    if owner.is_null() {
        return read_format_bytes_on_caller(format, deadline);
    }
    read_format_bytes_on_worker(format, deadline)
}

fn read_format_bytes_on_caller(
    format: u32,
    deadline: Deadline,
) -> Result<Option<Vec<u8>>, AdapterError> {
    let _session = ClipboardSession::open_for_read(deadline)?;
    copy_clipboard_format(format)
}

fn read_format_bytes_on_worker(
    format: u32,
    deadline: Deadline,
) -> Result<Option<Vec<u8>>, AdapterError> {
    #[cfg(test)]
    let size_override = GLOBAL_SIZE_OVERRIDE_BYTES.with(Cell::get);
    let (sender, receiver) = channel();
    let ticket = crate::input::clipboard::clipboard_worker_state::WorkerTicket::arm();
    thread::spawn(move || {
        #[cfg(test)]
        seed_worker_global_size_override(size_override);
        let result = {
            let _ticket = ticket;
            (|| {
                let _session = ClipboardSession::open_for_read(deadline)?;
                copy_clipboard_format(format)
            })()
        };
        let _ = sender.send(result);
    });
    match receiver.recv_timeout(deadline.remaining()) {
        Ok(result) => result,
        Err(RecvTimeoutError::Timeout) => Err(deadline
            .timeout_error()
            .with_platform_detail(
                "GetClipboardData worker abandoned after the deadline (A22-3 unbounded delay-render)",
            )
            .with_disposition(DeliverySemantics::not_delivered())),
        Err(RecvTimeoutError::Disconnected) => Err(AdapterError::internal(
            "clipboard read worker disconnected before returning",
        )
        .with_disposition(DeliverySemantics::not_delivered())),
    }
}

fn copy_clipboard_format(format: u32) -> Result<Option<Vec<u8>>, AdapterError> {
    let handle = unsafe { GetClipboardData(format) };
    if handle.is_null() {
        return Ok(None);
    }
    Ok(Some(copy_global_handle(handle)?))
}

fn copy_global_handle(handle: HANDLE) -> Result<Vec<u8>, AdapterError> {
    let size = reported_global_size(handle);
    if size == 0 {
        return Err(AdapterError::new(
            ErrorCode::ActionFailed,
            "Clipboard payload handle reported zero size",
        )
        .with_disposition(DeliverySemantics::not_delivered()));
    }
    if size > MAX_CLIPBOARD_PAYLOAD_BYTES {
        return Err(AdapterError::new(
            ErrorCode::InvalidArgs,
            "Clipboard payload exceeds the supported size budget",
        )
        .with_suggestion("Reduce the source content or read a smaller clipboard format")
        .with_platform_detail(format!(
            "reported_size={size} max_bytes={MAX_CLIPBOARD_PAYLOAD_BYTES}"
        ))
        .with_disposition(DeliverySemantics::not_delivered()));
    }
    let locked = unsafe { GlobalLock(handle as _) };
    if locked.is_null() {
        return Err(AdapterError::new(
            ErrorCode::ActionFailed,
            "GlobalLock failed while copying clipboard payload",
        )
        .with_disposition(DeliverySemantics::not_delivered()));
    }
    let bytes = unsafe { std::slice::from_raw_parts(locked.cast::<u8>(), size) }.to_vec();
    unsafe {
        let _ = GlobalUnlock(handle as _);
    }
    Ok(bytes)
}

fn reported_global_size(handle: HANDLE) -> usize {
    #[cfg(test)]
    {
        let override_bytes = GLOBAL_SIZE_OVERRIDE_BYTES.with(Cell::get);
        if override_bytes != 0 {
            return override_bytes;
        }
    }
    unsafe { GlobalSize(handle as _) }
}

fn not_delivered(error: AdapterError) -> AdapterError {
    error.with_disposition(DeliverySemantics::not_delivered())
}

#[cfg(test)]
pub(crate) fn sequence_retries_observed() -> u32 {
    SEQUENCE_RETRY_OBSERVED.load(Ordering::SeqCst)
}

fn sequence_mismatch_injected() -> bool {
    #[cfg(test)]
    {
        INJECT_SEQUENCE_MISMATCH_ONCE.swap(false, Ordering::SeqCst)
    }
    #[cfg(not(test))]
    {
        false
    }
}

#[cfg(test)]
pub(crate) fn reset_sequence_retries_observed() {
    SEQUENCE_RETRY_OBSERVED.store(0, Ordering::SeqCst);
}

#[cfg(test)]
pub(crate) fn inject_sequence_mismatch_once() {
    INJECT_SEQUENCE_MISMATCH_ONCE.store(true, Ordering::SeqCst);
}

#[cfg(test)]
fn seed_worker_global_size_override(bytes: usize) {
    if bytes != 0 {
        GLOBAL_SIZE_OVERRIDE_BYTES.with(|cell| cell.set(bytes));
    }
}

#[cfg(test)]
pub(crate) fn with_global_size_override_for_test<R>(bytes: usize, run: impl FnOnce() -> R) -> R {
    crate::system::fixture::test_support::with_usize_flag(&GLOBAL_SIZE_OVERRIDE_BYTES, bytes, run)
}

pub(crate) mod clipboard_bytes;
pub(crate) mod clipboard_files;
#[cfg(target_os = "windows")]
pub(crate) mod clipboard_formats;
#[cfg(target_os = "windows")]
pub(crate) mod clipboard_guard;
#[cfg(target_os = "windows")]
pub(crate) mod clipboard_image;
#[cfg(target_os = "windows")]
pub(crate) mod clipboard_session;
pub(crate) mod clipboard_text;
pub(crate) mod clipboard_worker_state;
#[cfg(target_os = "windows")]
pub(crate) mod clipboard_write;
#[cfg(test)]
#[path = "clipboard_tests.rs"]
mod tests;
