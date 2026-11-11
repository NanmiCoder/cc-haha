use super::{
    MAX_CLIPBOARD_PAYLOAD_BYTES, clear, ensure_owner_responsive, get_clipboard_content,
    read_format_bytes, reset_sequence_retries_observed, sequence_retries_observed, set_content,
    with_global_size_override_for_test,
};
use crate::input::clipboard::clipboard_guard::MoveableMemory;
use crate::input::clipboard::clipboard_session::ClipboardSession;
use crate::input::clipboard::clipboard_text::encode_utf16_text;
use crate::system::capture::png_codec::encode_bgra_to_png;
use crate::system::fixture::test_time::deadline;
use crate::tree::fixture::bootstrap;
use crate::tree::fixture::fixture_clipboard::{
    ContendingClipboardHolder, DelayedClipboardOwner, clipboard_test_lock,
};
use agent_desktop_core::{
    AdapterError, ClipboardContent, ClipboardFormat, Deadline, DeliverySemantics, ErrorCode,
    ImageBuffer, ImageFormat, parse_png_dimensions,
};
use std::time::{Duration, Instant};
use windows_sys::Win32::System::DataExchange::{EmptyClipboard, EnumClipboardFormats};

#[derive(Clone, Debug, PartialEq, Eq)]
struct RawClipboardFormat {
    format: u32,
    payload: Vec<u8>,
}

struct SavedClipboard {
    formats: Vec<RawClipboardFormat>,
}

impl SavedClipboard {
    fn capture(deadline: Deadline) -> Result<Self, AdapterError> {
        ensure_owner_responsive()?;
        let _session = ClipboardSession::open_for_read(deadline)?;
        let mut formats = Vec::new();
        let mut next = 0_u32;
        loop {
            let format = unsafe { EnumClipboardFormats(next) };
            if format == 0 {
                break;
            }
            if let Some(payload) = read_format_bytes(format, deadline)? {
                formats.push(RawClipboardFormat { format, payload });
            }
            next = format;
        }
        formats.sort_by_key(|entry| entry.format);
        Ok(Self { formats })
    }

    fn restore(&self, deadline: Deadline) -> Result<(), AdapterError> {
        let _session = ClipboardSession::open_for_write(deadline)?;
        if unsafe { EmptyClipboard() } == 0 {
            return Err(AdapterError::new(
                ErrorCode::ActionFailed,
                "EmptyClipboard failed while restoring saved clipboard formats",
            )
            .with_disposition(DeliverySemantics::not_delivered()));
        }
        for entry in &self.formats {
            MoveableMemory::from_bytes(&entry.payload)?.set_clipboard_data(entry.format)?;
        }
        Ok(())
    }

    fn matches_current(&self, deadline: Deadline) -> Result<bool, AdapterError> {
        Ok(Self::capture(deadline)?.formats == self.formats)
    }
}

fn with_restored_clipboard(body: impl FnOnce()) {
    let _lock = clipboard_test_lock();
    bootstrap();
    let saved = SavedClipboard::capture(deadline(5_000)).expect("capture clipboard for restore");
    let body_result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(body));
    saved
        .restore(deadline(5_000))
        .expect("restore every saved clipboard format");
    if let Err(panic) = body_result {
        std::panic::resume_unwind(panic);
    }
    assert!(
        saved
            .matches_current(deadline(5_000))
            .expect("re-read clipboard for round-trip check"),
        "every raw clipboard format must round-trip through save/restore"
    );
}

#[test]
fn text_image_and_files_round_trip_under_save_restore_lock() {
    with_restored_clipboard(|| {
        set_content(
            &ClipboardContent::Text("agent-desktop-u8".into()),
            deadline(5_000),
        )
        .expect("set text");
        match get_clipboard_content(ClipboardFormat::Text, deadline(5_000))
            .expect("get text")
            .expect("text present")
        {
            ClipboardContent::Text(value) => assert_eq!(value, "agent-desktop-u8"),
            other => panic!("expected text, got {other:?}"),
        }

        let png = sample_png();
        let (width, height) = parse_png_dimensions(&png).expect("dims");
        set_content(
            &ClipboardContent::Image(ImageBuffer {
                data: png,
                format: ImageFormat::Png,
                width,
                height,
                scale_factor: 1.0,
            }),
            deadline(5_000),
        )
        .expect("set image");
        match get_clipboard_content(ClipboardFormat::Image, deadline(5_000))
            .expect("get image")
            .expect("image present")
        {
            ClipboardContent::Image(buffer) => {
                assert_eq!((buffer.width, buffer.height), (width, height));
                assert!(matches!(buffer.format, ImageFormat::Png));
                assert!(!buffer.data.is_empty());
            }
            other => panic!("expected image, got {other:?}"),
        }

        let path = std::env::temp_dir()
            .join("agent-desktop-clipboard-u8.txt")
            .to_string_lossy()
            .into_owned();
        set_content(
            &ClipboardContent::FileUrls(vec![path.clone()]),
            deadline(5_000),
        )
        .expect("set files");
        match get_clipboard_content(ClipboardFormat::FileUrls, deadline(5_000))
            .expect("get files")
            .expect("files present")
        {
            ClipboardContent::FileUrls(paths) => assert_eq!(paths, vec![path]),
            other => panic!("expected files, got {other:?}"),
        }
    });
}

#[test]
fn empty_clipboard_returns_ok_none_distinct_from_transport_error() {
    with_restored_clipboard(|| {
        clear(deadline(5_000)).expect("clear");
        for format in [
            ClipboardFormat::Text,
            ClipboardFormat::Image,
            ClipboardFormat::FileUrls,
            ClipboardFormat::Auto,
        ] {
            assert!(
                get_clipboard_content(format, deadline(5_000))
                    .expect("absence is Ok")
                    .is_none()
            );
        }
        set_content(&ClipboardContent::Text("held".into()), deadline(5_000)).expect("seed");
        let mut holder = ContendingClipboardHolder::spawn().expect("holder");
        let error =
            get_clipboard_content(ClipboardFormat::Text, Deadline::after(200).expect("short"))
                .expect_err("contention against an advertised format is Err");
        assert_eq!(error.code, ErrorCode::Timeout);
        holder.release().expect("release");
    });
}

#[test]
fn auto_prefers_files_then_image_then_text() {
    with_restored_clipboard(|| {
        let png = sample_png();
        let (width, height) = parse_png_dimensions(&png).expect("dims");
        set_content(
            &ClipboardContent::Image(ImageBuffer {
                data: png,
                format: ImageFormat::Png,
                width,
                height,
                scale_factor: 1.0,
            }),
            deadline(5_000),
        )
        .expect("image");
        add_text_without_clearing().expect("add text");
        let auto = get_clipboard_content(ClipboardFormat::Auto, deadline(5_000))
            .expect("auto")
            .expect("content");
        assert!(matches!(auto, ClipboardContent::Image(_)));

        let path = std::env::temp_dir()
            .join("agent-desktop-clipboard-auto.txt")
            .to_string_lossy()
            .into_owned();
        set_content(&ClipboardContent::FileUrls(vec![path]), deadline(5_000)).expect("files");
        let auto = get_clipboard_content(ClipboardFormat::Auto, deadline(5_000))
            .expect("auto files")
            .expect("content");
        assert!(matches!(auto, ClipboardContent::FileUrls(_)));
    });
}

#[test]
fn hung_delay_owner_returns_app_unresponsive() {
    with_restored_clipboard(|| {
        let owner = DelayedClipboardOwner::create().expect("delayed owner");
        assert!(owner.format_available());
        let started = Instant::now();
        let error = get_clipboard_content(ClipboardFormat::Text, deadline(5_000))
            .expect_err("hung owner must fail closed");
        assert_eq!(error.code, ErrorCode::AppUnresponsive);
        assert_eq!(error.disposition, DeliverySemantics::not_delivered());
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "pre-probe must return rather than hang on GetClipboardData"
        );
    });
}

#[test]
fn sequence_retry_is_observed_when_clipboard_moves_mid_read() {
    with_restored_clipboard(|| {
        reset_sequence_retries_observed();
        set_content(&ClipboardContent::Text("stable".into()), deadline(5_000)).expect("set");
        super::inject_sequence_mismatch_once();
        let content = get_clipboard_content(ClipboardFormat::Text, deadline(5_000))
            .expect("retry must still return content")
            .expect("text present");
        assert!(matches!(content, ClipboardContent::Text(_)));
        assert!(
            sequence_retries_observed() > 0,
            "a mid-read sequence move must trigger the stable-read retry"
        );
    });
}

#[test]
fn oversized_clipboard_payload_is_rejected_before_copy() {
    with_restored_clipboard(|| {
        set_content(&ClipboardContent::Text("small".into()), deadline(5_000)).expect("set");
        with_global_size_override_for_test(MAX_CLIPBOARD_PAYLOAD_BYTES + 1, || {
            let error = get_clipboard_content(ClipboardFormat::Text, deadline(5_000))
                .expect_err("hostile GlobalSize must fail before allocating the payload");
            assert_eq!(error.code, ErrorCode::InvalidArgs);
            assert_eq!(error.disposition, DeliverySemantics::not_delivered());
            let detail = error.platform_detail.unwrap_or_default();
            assert!(
                detail.contains(&MAX_CLIPBOARD_PAYLOAD_BYTES.to_string()),
                "platform detail must name the cap, got {detail}"
            );
        });
    });
}

fn sample_png() -> Vec<u8> {
    encode_bgra_to_png(
        &[
            10, 20, 30, 255, 40, 50, 60, 255, 70, 80, 90, 255, 100, 110, 120, 255,
        ],
        2,
        2,
        8,
        deadline(5_000),
    )
    .expect("png")
}

fn add_text_without_clearing() -> Result<(), AdapterError> {
    let _session = ClipboardSession::open_for_write(deadline(5_000))?;
    let bytes = encode_utf16_text("alongside")?;
    MoveableMemory::from_bytes(&bytes)?.set_clipboard_data(13)?;
    Ok(())
}
