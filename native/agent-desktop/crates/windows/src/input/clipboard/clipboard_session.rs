//! Clipboard open/close RAII, hidden write owner window, and contention retry.
//!
//! Writes and clears must open with the process-owned `HWND_MESSAGE` window
//! (A22 / documented `SetClipboardData` NULL-owner failure). Reads may open
//! with `NULL`. Contention retries use the fixed attempt/interval constants
//! real producers use; exhaustion is `TIMEOUT` and names `GetOpenClipboardWindow`
//! without inventing whether a NULL answer means free or a windowless holder.

use agent_desktop_core::{AdapterError, Deadline, DeliverySemantics};
use std::sync::OnceLock;
use std::sync::mpsc::channel;
use std::thread;
use std::time::Duration;

use windows_sys::Win32::Foundation::HWND;
use windows_sys::Win32::System::DataExchange::{
    CloseClipboard, GetOpenClipboardWindow, OpenClipboard,
};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::UI::WindowsAndMessaging::{CreateWindowExW, HWND_MESSAGE};

/// Chromium-shaped open budget: a handful of attempts a few milliseconds apart.
pub(crate) const OPEN_CLIPBOARD_RETRY_ATTEMPTS: u32 = 5;
pub(crate) const OPEN_CLIPBOARD_RETRY_INTERVAL_MS: u64 = 5;

pub(crate) struct ClipboardSession {
    closed: bool,
}

impl ClipboardSession {
    pub(crate) fn open_for_read(deadline: Deadline) -> Result<Self, AdapterError> {
        open_with_owner(std::ptr::null_mut(), deadline)
    }

    pub(crate) fn open_for_write(deadline: Deadline) -> Result<Self, AdapterError> {
        let owner = owner_hwnd()?;
        open_with_owner(owner, deadline)
    }

    pub(crate) fn owner_hwnd() -> Result<HWND, AdapterError> {
        owner_hwnd()
    }
}

impl Drop for ClipboardSession {
    fn drop(&mut self) {
        if self.closed {
            return;
        }
        unsafe {
            let _ = CloseClipboard();
        }
        self.closed = true;
    }
}

fn open_with_owner(owner: HWND, deadline: Deadline) -> Result<ClipboardSession, AdapterError> {
    deadline.ensure_remaining().map_err(not_delivered)?;
    for attempt in 0..OPEN_CLIPBOARD_RETRY_ATTEMPTS {
        deadline.ensure_remaining().map_err(not_delivered)?;
        if unsafe { OpenClipboard(owner) } != 0 {
            return Ok(ClipboardSession { closed: false });
        }
        if attempt + 1 == OPEN_CLIPBOARD_RETRY_ATTEMPTS {
            break;
        }
        let sleep_for =
            Duration::from_millis(OPEN_CLIPBOARD_RETRY_INTERVAL_MS).min(deadline.remaining());
        if sleep_for.is_zero() {
            break;
        }
        thread::sleep(sleep_for);
    }
    Err(contention_timeout(deadline))
}

fn contention_timeout(deadline: Deadline) -> AdapterError {
    let holder = unsafe { GetOpenClipboardWindow() };
    let holder_detail = if holder.is_null() {
        "GetOpenClipboardWindow returned NULL, which is ambiguous between a free clipboard and a windowless holder".to_string()
    } else {
        format!(
            "GetOpenClipboardWindow returned HWND 0x{:X}; the clipboard is held and that window is the reported holder",
            holder as usize
        )
    };
    deadline
        .timeout_error()
        .with_platform_detail(holder_detail)
        .with_suggestion(
            "Retry after the current clipboard holder closes it; OpenClipboard permits only one holder",
        )
        .with_disposition(DeliverySemantics::not_delivered())
}

fn owner_hwnd() -> Result<HWND, AdapterError> {
    static OWNER: OnceLock<Result<isize, String>> = OnceLock::new();
    let stored = OWNER.get_or_init(|| {
        let (sender, receiver) = channel();
        thread::spawn(move || owner_thread_main(sender));
        match receiver.recv_timeout(Duration::from_secs(5)) {
            Ok(handle) if handle != 0 => Ok(handle),
            Ok(_) => Err("CreateWindowExW produced no HWND_MESSAGE clipboard owner".into()),
            Err(_) => Err("clipboard owner thread never published its HWND".into()),
        }
    });
    match stored {
        Ok(handle) => Ok(*handle as HWND),
        Err(message) => Err(AdapterError::internal(message.clone())
            .with_disposition(DeliverySemantics::not_delivered())),
    }
}

fn create_message_owner_window() -> HWND {
    let class = wide("STATIC");
    let title = wide("agent-desktop-clipboard-owner");
    unsafe {
        CreateWindowExW(
            0,
            class.as_ptr(),
            title.as_ptr(),
            0,
            0,
            0,
            0,
            0,
            HWND_MESSAGE,
            std::ptr::null_mut(),
            GetModuleHandleW(std::ptr::null()),
            std::ptr::null(),
        )
    }
}

fn owner_thread_main(sender: std::sync::mpsc::Sender<isize>) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        DispatchMessageW, GetMessageW, MSG, TranslateMessage, WM_QUIT,
    };

    let hwnd = create_message_owner_window();
    let _ = sender.send(hwnd as isize);
    if hwnd.is_null() {
        return;
    }
    let mut message = MSG::default();
    loop {
        let status = unsafe { GetMessageW(&mut message, std::ptr::null_mut(), 0, 0) };
        if status == 0 || status == -1 || message.message == WM_QUIT {
            break;
        }
        unsafe {
            let _ = TranslateMessage(&message);
            let _ = DispatchMessageW(&message);
        }
    }
}

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

fn not_delivered(error: AdapterError) -> AdapterError {
    error.with_disposition(DeliverySemantics::not_delivered())
}

#[cfg(test)]
pub(crate) fn open_clipboard_raw(owner: Option<HWND>) -> bool {
    let hwnd = owner.unwrap_or(std::ptr::null_mut());
    unsafe { OpenClipboard(hwnd) != 0 }
}

#[cfg(test)]
pub(crate) fn close_clipboard_raw() {
    unsafe {
        let _ = CloseClipboard();
    }
}

#[cfg(test)]
#[path = "clipboard_session_tests.rs"]
mod tests;
