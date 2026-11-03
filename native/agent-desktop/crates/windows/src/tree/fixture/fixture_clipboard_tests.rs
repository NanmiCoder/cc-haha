use super::*;
use crate::system::window::window_enum::window_is_responsive;

#[test]
#[ignore = "runs only in the re-executed clipboard holder host process"]
fn clipboard_holder_host_process_entry() {
    assert!(
        is_clipboard_holder_host(),
        "the clipboard holder entry must not run without the host flag"
    );
    run_as_clipboard_holder_host();
}

#[test]
fn delayed_owner_advertises_format_then_stops_pumping() {
    let _lock = clipboard_test_lock();
    let owner = DelayedClipboardOwner::create().expect("delayed owner starts");
    assert!(
        owner.format_available(),
        "delay-rendered CF_UNICODETEXT must be advertised"
    );
    assert!(
        owner.owner_is_self(),
        "GetClipboardOwner must name the delayed-owner window"
    );
    assert!(
        !window_is_responsive(owner.handle() as _),
        "the delayed owner must stop pumping after advertising"
    );
}

#[test]
fn contending_holder_is_a_second_process_that_blocks_open() {
    let _lock = clipboard_test_lock();
    let mut holder = ContendingClipboardHolder::spawn().expect("holder starts");
    assert_ne!(
        holder.process_id(),
        std::process::id(),
        "contention requires a genuine second process"
    );
    assert_ne!(holder.open_clipboard_window(), 0);
    assert!(
        !try_open_clipboard(None),
        "OpenClipboard must fail while the holder keeps the clipboard open"
    );
    holder.release().expect("holder releases on request");
    assert!(
        try_open_clipboard(None),
        "OpenClipboard must succeed after the holder releases"
    );
    close_clipboard();
}

#[test]
fn delayed_owner_clears_delay_format_on_drop() {
    let _lock = clipboard_test_lock();
    {
        let owner = DelayedClipboardOwner::create().expect("delayed owner starts");
        assert!(owner.format_available());
    }
    assert!(
        !unsafe { windows_sys::Win32::System::DataExchange::IsClipboardFormatAvailable(13) != 0 },
        "dropping the delayed owner must clear the advertised delay-rendered format"
    );
}
