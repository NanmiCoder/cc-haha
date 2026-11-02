use super::{
    ClipboardSession, OPEN_CLIPBOARD_RETRY_ATTEMPTS, OPEN_CLIPBOARD_RETRY_INTERVAL_MS,
    close_clipboard_raw, open_clipboard_raw, owner_hwnd,
};
use crate::input::clipboard::clipboard_guard::MoveableMemory;
use crate::system::window::window_ops::list_windows_live;
use crate::tree::fixture::fixture_clipboard::{ContendingClipboardHolder, clipboard_test_lock};
use agent_desktop_core::{Deadline, ErrorCode, WindowFilter};
use std::time::{Duration, Instant};
use windows_sys::Win32::Foundation::GlobalFree;
use windows_sys::Win32::System::DataExchange::{
    EmptyClipboard, GetClipboardOwner, SetClipboardData,
};
use windows_sys::Win32::System::Memory::{GMEM_MOVEABLE, GlobalAlloc};

#[test]
fn retry_constants_are_named_and_finite() {
    assert_eq!(OPEN_CLIPBOARD_RETRY_ATTEMPTS, 5);
    assert_eq!(OPEN_CLIPBOARD_RETRY_INTERVAL_MS, 5);
}

#[test]
fn hidden_owner_window_never_appears_in_list_windows() {
    let _lock = clipboard_test_lock();
    let owner = owner_hwnd().expect("owner window");
    let expected_id = format!("w-{}", owner as usize);
    let windows = list_windows_live(
        &WindowFilter::default(),
        Deadline::after(5_000).expect("deadline"),
    )
    .expect("list windows");
    assert!(
        windows.iter().all(|window| window.id != expected_id),
        "HWND_MESSAGE clipboard owner must not appear in top-level enumeration"
    );
}

#[test]
fn write_open_uses_hidden_owner_while_null_owner_leaves_ownership_unset() {
    let _lock = clipboard_test_lock();
    assert!(
        open_clipboard_raw(None),
        "OpenClipboard(NULL) must succeed for the negative control"
    );
    assert_ne!(unsafe { EmptyClipboard() }, 0);
    let owner_after_null_empty = unsafe { GetClipboardOwner() };
    assert!(
        owner_after_null_empty.is_null(),
        "EmptyClipboard after OpenClipboard(NULL) must leave the clipboard owner unset"
    );
    let alloc = unsafe { GlobalAlloc(GMEM_MOVEABLE, 4) };
    assert!(!alloc.is_null());
    let set = unsafe { SetClipboardData(13, alloc as _) };
    if set.is_null() {
        unsafe {
            let _ = GlobalFree(alloc);
        }
    }
    close_clipboard_raw();

    let deadline = Deadline::after(2_000).expect("deadline");
    let session = ClipboardSession::open_for_write(deadline).expect("write open");
    assert_ne!(unsafe { EmptyClipboard() }, 0);
    let owner = owner_hwnd().expect("owner");
    assert_eq!(unsafe { GetClipboardOwner() }, owner);
    MoveableMemory::from_bytes(&[0u8, 0, 0, 0])
        .expect("alloc")
        .set_clipboard_data(13)
        .expect("SetClipboardData through the hidden owner must succeed");
    assert_eq!(unsafe { GetClipboardOwner() }, owner);
    drop(session);
}

#[test]
fn contention_exhaustion_is_timeout_within_deadline_budget() {
    let _lock = clipboard_test_lock();
    let mut holder = ContendingClipboardHolder::spawn().expect("holder");
    let deadline = Deadline::after(500).expect("short deadline");
    let started = Instant::now();
    let error = match ClipboardSession::open_for_read(deadline) {
        Ok(_) => panic!("must time out under contention"),
        Err(error) => error,
    };
    let elapsed = started.elapsed();
    assert_eq!(error.code, ErrorCode::Timeout);
    assert!(
        elapsed < Duration::from_millis(500),
        "contention retry must stay inside the deadline, elapsed={elapsed:?}"
    );
    let detail = error.platform_detail.unwrap_or_default();
    assert!(
        detail.contains("GetOpenClipboardWindow"),
        "contention envelope must name GetOpenClipboardWindow"
    );
    holder.release().expect("release");
}
