use super::{clear_clipboard, force_ownership_loss_for_test, set_clipboard_content};
use crate::system::fixture::test_time::deadline;
use crate::tree::fixture::bootstrap;
use crate::tree::fixture::fixture_clipboard::clipboard_test_lock;
use agent_desktop_core::{
    ClipboardContent, DeliverySemantics, ErrorCode, ImageBuffer, ImageFormat,
};

#[test]
fn image_metadata_mismatch_is_rejected_before_native_open() {
    let _lock = clipboard_test_lock();
    bootstrap();
    let error = set_clipboard_content(
        &ClipboardContent::Image(ImageBuffer {
            data: tiny_png(),
            format: ImageFormat::Png,
            width: 99,
            height: 99,
            scale_factor: 1.0,
        }),
        deadline(5_000),
    )
    .expect_err("metadata mismatch must fail");
    assert_eq!(error.code, ErrorCode::InvalidArgs);
    assert_eq!(error.disposition, DeliverySemantics::not_delivered());
}

#[test]
fn ownership_loss_reports_delivered_unverified_not_ok() {
    let _lock = clipboard_test_lock();
    bootstrap();
    struct Reset;
    impl Drop for Reset {
        fn drop(&mut self) {
            force_ownership_loss_for_test(false);
        }
    }
    let _reset = Reset;
    force_ownership_loss_for_test(true);
    let error = set_clipboard_content(&ClipboardContent::Text("owned".into()), deadline(5_000))
        .expect_err("lost ownership must not report ok");
    assert_eq!(error.code, ErrorCode::AppUnresponsive);
    assert_eq!(error.disposition, DeliverySemantics::delivered_unverified());
}

#[test]
fn clear_empties_text_format() {
    let _lock = clipboard_test_lock();
    bootstrap();
    set_clipboard_content(&ClipboardContent::Text("temporary".into()), deadline(5_000))
        .expect("set");
    clear_clipboard(deadline(5_000)).expect("clear");
    assert!(
        unsafe { windows_sys::Win32::System::DataExchange::IsClipboardFormatAvailable(13) == 0 },
        "clear must remove CF_UNICODETEXT"
    );
}

fn tiny_png() -> Vec<u8> {
    crate::system::capture::png_codec::encode_bgra_to_png(
        &[
            0, 0, 255, 255, 0, 255, 0, 255, 255, 0, 0, 255, 255, 255, 255, 255,
        ],
        2,
        2,
        8,
        deadline(5_000),
    )
    .expect("encode")
}
