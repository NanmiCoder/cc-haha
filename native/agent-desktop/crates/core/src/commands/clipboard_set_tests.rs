use super::*;
use crate::adapter::{ActionOps, InputOps, ObservationOps, SystemOps};
use crate::{AdapterError, ErrorCode};
use std::io::Write;
use std::sync::Mutex;

struct LocalDouble {
    seen: Mutex<Option<ClipboardContent>>,
}

impl LocalDouble {
    fn new() -> Self {
        Self {
            seen: Mutex::new(None),
        }
    }
}

impl ObservationOps for LocalDouble {}
impl ActionOps for LocalDouble {}
impl SystemOps for LocalDouble {
    crate::adapter::guarded_interaction_lease!();
}

impl InputOps for LocalDouble {
    fn set_clipboard_content(
        &self,
        content: &ClipboardContent,
        _lease: &crate::InteractionLease,
    ) -> Result<crate::OperationReport, AdapterError> {
        let stored = match content {
            ClipboardContent::Text(text) => ClipboardContent::Text(text.clone()),
            ClipboardContent::Image(image) => ClipboardContent::Image(ImageBuffer {
                data: image.data.clone(),
                format: crate::ImageFormat::Png,
                width: image.width,
                height: image.height,
                scale_factor: image.scale_factor,
            }),
            ClipboardContent::FileUrls(urls) => ClipboardContent::FileUrls(urls.clone()),
        };
        *self.seen.lock().unwrap() = Some(stored);
        Ok(crate::adapter::test_report())
    }
}

#[test]
fn default_with_only_text_writes_text_content() {
    let double = LocalDouble::new();
    let out = execute(
        ClipboardSetArgs {
            text: Some("hello clipboard".into()),
            image: None,
            file_urls: vec![],
        },
        &double,
    )
    .unwrap();
    assert_eq!(out["type"], "text");
    match double.seen.lock().unwrap().as_ref().unwrap() {
        ClipboardContent::Text(text) => assert_eq!(text, "hello clipboard"),
        _ => panic!("expected Text content"),
    }
}

#[test]
fn omitted_text_defaults_to_empty_string_not_error() {
    let double = LocalDouble::new();
    let out = execute(
        ClipboardSetArgs {
            text: None,
            image: None,
            file_urls: vec![],
        },
        &double,
    )
    .unwrap();
    assert_eq!(out["type"], "text");
    match double.seen.lock().unwrap().as_ref().unwrap() {
        ClipboardContent::Text(text) => assert_eq!(text, ""),
        _ => panic!("expected Text content"),
    }
}

#[test]
fn missing_file_url_reports_invalid_args_with_count_and_index_only() {
    let existing = std::env::temp_dir().join(format!(
        "agent-desktop-clipboard-set-test-{}.txt",
        crate::refs::new_snapshot_id()
    ));
    std::fs::File::create_new(&existing)
        .unwrap()
        .write_all(b"present")
        .unwrap();

    let double = LocalDouble::new();
    let err = execute(
        ClipboardSetArgs {
            text: None,
            image: None,
            file_urls: vec![
                existing.to_string_lossy().into_owned(),
                "/definitely/does/not/exist/secret-project-name.txt".into(),
            ],
        },
        &double,
    )
    .unwrap_err();

    let _ = std::fs::remove_file(&existing);

    assert_eq!(err.code(), ErrorCode::InvalidArgs.as_str());
    let message = err.to_string();
    assert!(
        message.contains("1 of 2"),
        "message should report count, got: {message}"
    );
    assert!(
        message.contains("[1]"),
        "message should report the missing entry's index (1), got: {message}"
    );
    assert!(
        !message.contains("secret-project-name"),
        "message must not leak the missing path's content, got: {message}"
    );
    assert!(
        double.seen.lock().unwrap().is_none(),
        "adapter must not be called on validation failure"
    );
}

#[test]
fn image_flag_reads_bytes_and_dimensions_from_file() {
    let path = std::env::temp_dir().join(format!(
        "agent-desktop-clipboard-set-image-{}.png",
        crate::refs::new_snapshot_id()
    ));
    let bytes = vec![
        137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 4,
        0, 0, 0, 181, 28, 12, 2, 0, 0, 0, 11, 73, 68, 65, 84, 120, 218, 99, 100, 248, 15, 0, 1, 5,
        1, 1, 39, 24, 227, 102, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
    ];
    std::fs::File::create_new(&path)
        .unwrap()
        .write_all(&bytes)
        .unwrap();

    let double = LocalDouble::new();
    let out = execute(
        ClipboardSetArgs {
            text: None,
            image: Some(path.clone()),
            file_urls: vec![],
        },
        &double,
    )
    .unwrap();

    let _ = std::fs::remove_file(&path);

    assert_eq!(out["type"], "image");
    match double.seen.lock().unwrap().as_ref().unwrap() {
        ClipboardContent::Image(image) => {
            assert_eq!(image.width, 1);
            assert_eq!(image.height, 1);
            assert_eq!(image.data, bytes);
        }
        _ => panic!("expected Image content"),
    }
}

#[test]
fn missing_image_path_reports_invalid_args() {
    let missing = std::env::temp_dir().join(format!(
        "agent-desktop-missing-clipboard-image-{}.png",
        crate::refs::new_snapshot_id()
    ));

    let error = build_content(ClipboardSetArgs {
        text: None,
        image: Some(missing),
        file_urls: Vec::new(),
    })
    .unwrap_err();

    assert_eq!(error.code(), ErrorCode::InvalidArgs.as_str());
}

#[test]
fn file_urls_take_priority_over_text_and_image() {
    let existing = std::env::temp_dir().join(format!(
        "agent-desktop-clipboard-set-priority-{}.txt",
        crate::refs::new_snapshot_id()
    ));
    std::fs::File::create_new(&existing)
        .unwrap()
        .write_all(b"present")
        .unwrap();

    let double = LocalDouble::new();
    let out = execute(
        ClipboardSetArgs {
            text: Some("ignored".into()),
            image: None,
            file_urls: vec![existing.to_string_lossy().into_owned()],
        },
        &double,
    )
    .unwrap();

    let _ = std::fs::remove_file(&existing);

    assert_eq!(out["type"], "file_urls");
    match double.seen.lock().unwrap().as_ref().unwrap() {
        ClipboardContent::FileUrls(urls) => assert_eq!(urls.len(), 1),
        _ => panic!("expected FileUrls content"),
    }
}

#[cfg(unix)]
#[test]
fn image_rejects_fifo_without_blocking() {
    use std::ffi::CString;

    let path = std::env::temp_dir().join(format!(
        "agent-desktop-clipboard-set-fifo-{}",
        crate::refs::new_snapshot_id()
    ));
    let c_path = CString::new(path.to_string_lossy().as_bytes()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(c_path.as_ptr(), 0o600) }, 0);
    let started = std::time::Instant::now();

    let error = build_content(ClipboardSetArgs {
        text: None,
        image: Some(path.clone()),
        file_urls: Vec::new(),
    })
    .unwrap_err();

    assert_eq!(error.code(), ErrorCode::InvalidArgs.as_str());
    assert!(started.elapsed() < std::time::Duration::from_secs(1));
    std::fs::remove_file(path).unwrap();
}

#[cfg(unix)]
#[test]
fn image_rejects_device_files() {
    let error = build_content(ClipboardSetArgs {
        text: None,
        image: Some(PathBuf::from("/dev/null")),
        file_urls: Vec::new(),
    })
    .unwrap_err();

    assert_eq!(error.code(), ErrorCode::InvalidArgs.as_str());
}
