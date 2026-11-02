//! Ownership-transfer guard for `GlobalAlloc(GMEM_MOVEABLE)` clipboard payloads.
//!
//! A successful `SetClipboardData` transfers the handle to the system; the
//! guard must release without freeing. A failed `SetClipboardData` leaves the
//! handle ours, so `Drop` frees it.

use agent_desktop_core::{AdapterError, DeliverySemantics, ErrorCode};
use std::ptr;

use windows_sys::Win32::Foundation::{GetLastError, GlobalFree, HANDLE, HGLOBAL};
use windows_sys::Win32::System::DataExchange::SetClipboardData;
use windows_sys::Win32::System::Memory::{GMEM_MOVEABLE, GlobalAlloc, GlobalLock, GlobalUnlock};

pub(crate) struct MoveableMemory {
    handle: HGLOBAL,
    transferred: bool,
}

impl MoveableMemory {
    pub(crate) fn from_bytes(bytes: &[u8]) -> Result<Self, AdapterError> {
        if bytes.is_empty() {
            return Err(AdapterError::new(
                ErrorCode::InvalidArgs,
                "Clipboard payload allocation refused an empty buffer",
            ));
        }
        let handle = unsafe { GlobalAlloc(GMEM_MOVEABLE, bytes.len()) };
        if handle.is_null() {
            return Err(AdapterError::new(
                ErrorCode::Internal,
                "GlobalAlloc failed for a clipboard payload",
            )
            .with_platform_detail(format!("GetLastError={}", unsafe { GetLastError() })));
        }
        let locked = unsafe { GlobalLock(handle) };
        if locked.is_null() {
            unsafe {
                let _ = GlobalFree(handle);
            }
            return Err(AdapterError::new(
                ErrorCode::Internal,
                "GlobalLock failed for a clipboard payload",
            )
            .with_platform_detail(format!("GetLastError={}", unsafe { GetLastError() })));
        }
        unsafe {
            ptr::copy_nonoverlapping(bytes.as_ptr(), locked.cast::<u8>(), bytes.len());
            let _ = GlobalUnlock(handle);
        }
        Ok(Self {
            handle,
            transferred: false,
        })
    }

    pub(crate) fn set_clipboard_data(mut self, format: u32) -> Result<(), AdapterError> {
        let result = unsafe { SetClipboardData(format, self.handle as HANDLE) };
        if result.is_null() {
            let error = unsafe { GetLastError() };
            return Err(AdapterError::new(
                ErrorCode::ActionFailed,
                "SetClipboardData failed after the clipboard was emptied",
            )
            .with_platform_detail(format!("format={format} GetLastError={error}"))
            .with_disposition(DeliverySemantics::delivered_unverified()));
        }
        self.transferred = true;
        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn handle_for_test(&self) -> HGLOBAL {
        self.handle
    }

    #[cfg(test)]
    pub(crate) fn release_without_free_for_test(mut self) {
        self.transferred = true;
    }

    #[cfg(test)]
    pub(crate) fn was_transferred(&self) -> bool {
        self.transferred
    }
}

impl Drop for MoveableMemory {
    fn drop(&mut self) {
        if self.transferred || self.handle.is_null() {
            return;
        }
        unsafe {
            let _ = GlobalFree(self.handle);
        }
        self.handle = ptr::null_mut();
        #[cfg(test)]
        FREES.with(|frees| frees.set(frees.get() + 1));
    }
}

#[cfg(test)]
thread_local! {
    static FREES: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

#[cfg(test)]
pub(crate) fn frees_on_this_thread() -> usize {
    FREES.with(std::cell::Cell::get)
}

#[cfg(test)]
#[path = "clipboard_guard_tests.rs"]
mod tests;
