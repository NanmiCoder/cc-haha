use super::*;
use crate::AdapterError;
use crate::adapter::{ActionOps, InputOps, ObservationOps, SystemOps};
use crate::refs::refs_test_support::HomeGuard;
use std::sync::Mutex;

#[path = "clipboard_get_output_tests.rs"]
mod output_tests;

struct LocalDouble {
    response: Mutex<Option<Result<Option<ClipboardContent>, AdapterError>>>,
    seen_format: Mutex<Option<ClipboardFormat>>,
}

impl LocalDouble {
    fn returning(result: Result<Option<ClipboardContent>, AdapterError>) -> Self {
        Self {
            response: Mutex::new(Some(result)),
            seen_format: Mutex::new(None),
        }
    }
}

impl ObservationOps for LocalDouble {}
impl ActionOps for LocalDouble {}
impl SystemOps for LocalDouble {}

impl InputOps for LocalDouble {
    fn get_clipboard_content(
        &self,
        format: ClipboardFormat,
        _deadline: crate::Deadline,
    ) -> Result<Option<ClipboardContent>, AdapterError> {
        *self.seen_format.lock().unwrap() = Some(format);
        self.response
            .lock()
            .unwrap()
            .take()
            .expect("double invoked more than once in a single test")
    }
}

fn no_session_context() -> CommandContext {
    CommandContext::default()
}

#[test]
fn omitted_format_defaults_to_text_not_auto() {
    let double = LocalDouble::returning(Ok(Some(ClipboardContent::Text("hi there".into()))));
    let out = execute(
        ClipboardGetArgs {
            format: None,
            out: None,
        },
        &double,
        &no_session_context(),
    )
    .unwrap();
    assert_eq!(
        *double.seen_format.lock().unwrap(),
        Some(ClipboardFormat::Text)
    );
    assert_eq!(out["type"], "text");
    assert_eq!(out["text"], "hi there");
}

#[test]
fn missing_content_for_requested_format_is_structured_not_found_not_an_error() {
    let double = LocalDouble::returning(Ok(None));
    let out = execute(
        ClipboardGetArgs {
            format: Some(ClipboardFormat::Image),
            out: None,
        },
        &double,
        &no_session_context(),
    )
    .expect("must return Ok(..) not panic or bubble a hard error");
    assert_eq!(out["type"], "image");
    assert_eq!(out["found"], false);
}

#[test]
fn file_urls_variant_serializes_list() {
    let double = LocalDouble::returning(Ok(Some(ClipboardContent::FileUrls(vec![
        "/tmp/a.txt".into(),
        "/tmp/b.txt".into(),
    ]))));
    let out = execute(
        ClipboardGetArgs {
            format: Some(ClipboardFormat::FileUrls),
            out: None,
        },
        &double,
        &no_session_context(),
    )
    .unwrap();
    assert_eq!(out["type"], "file_urls");
    assert_eq!(
        out["file_urls"],
        serde_json::json!(["/tmp/a.txt", "/tmp/b.txt"])
    );
}

#[test]
fn auto_format_request_is_relayed_to_adapter_unmodified() {
    let double = LocalDouble::returning(Ok(Some(ClipboardContent::Text("auto text".into()))));
    let _ = execute(
        ClipboardGetArgs {
            format: Some(ClipboardFormat::Auto),
            out: None,
        },
        &double,
        &no_session_context(),
    )
    .unwrap();
    assert_eq!(
        *double.seen_format.lock().unwrap(),
        Some(ClipboardFormat::Auto)
    );
}

#[test]
fn image_variant_with_explicit_out_writes_that_path() {
    let _home = HomeGuard::new();
    let dir = std::env::temp_dir().join(format!(
        "agent-desktop-clipboard-get-test-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    let out_path = dir.join("explicit.png");

    let double = LocalDouble::returning(Ok(Some(ClipboardContent::Image(ImageBuffer {
        data: vec![1, 2, 3, 4],
        format: crate::ImageFormat::Png,
        width: 10,
        height: 5,
        scale_factor: 1.0,
    }))));
    let out = execute(
        ClipboardGetArgs {
            format: Some(ClipboardFormat::Image),
            out: Some(out_path.clone()),
        },
        &double,
        &no_session_context(),
    )
    .unwrap();

    assert_eq!(out["type"], "image");
    assert_eq!(out["path"], out_path.to_string_lossy().into_owned());
    assert_eq!(out["width"], 10);
    assert_eq!(out["height"], 5);
    assert_eq!(std::fs::read(&out_path).unwrap(), vec![1, 2, 3, 4]);

    let _ = std::fs::remove_dir_all(&dir);
}

fn write_with_age(path: &std::path::Path, contents: &[u8], age: Duration) {
    std::fs::write(path, contents).unwrap();
    let file = std::fs::OpenOptions::new().write(true).open(path).unwrap();
    file.set_modified(SystemTime::now() - age).unwrap();
}

#[test]
fn clipboard_image_predicate_matches_only_the_generated_shape() {
    assert!(is_clipboard_image_file(Path::new(
        "clipboard-123-456-0.png"
    )));
    assert!(!is_clipboard_image_file(Path::new(
        "clipboard-123-456-0.png.tmp"
    )));
    assert!(!is_clipboard_image_file(Path::new("other.png")));
    assert!(!is_clipboard_image_file(Path::new("clipboard-123.txt")));
}

#[test]
fn sessionless_prune_removes_stale_matches_keeps_fresh_and_unrelated() {
    let _home = HomeGuard::new();
    let dir = session::agent_desktop_dir().unwrap().join("tmp");
    std::fs::create_dir_all(&dir).unwrap();

    let stale_png = dir.join("clipboard-1-1-0.png");
    let stale_tmp = dir.join("orphan-write.tmp");
    let fresh_png = dir.join("clipboard-2-2-0.png");
    let unrelated = dir.join("notes.txt");
    write_with_age(
        &stale_png,
        b"old",
        CLIPBOARD_IMAGE_MAX_AGE + Duration::from_secs(1),
    );
    write_with_age(
        &stale_tmp,
        b"old",
        STALE_TMP_MAX_AGE + Duration::from_secs(1),
    );
    write_with_age(&fresh_png, b"new", Duration::from_secs(1));
    write_with_age(
        &unrelated,
        b"keep me",
        CLIPBOARD_IMAGE_MAX_AGE + Duration::from_secs(1),
    );

    prune_sessionless_clipboard_tmp_dir(&dir);

    assert!(
        !stale_png.exists(),
        "clipboard png older than its TTL must be pruned"
    );
    assert!(
        !stale_tmp.exists(),
        "orphaned tmp file older than its TTL must be pruned"
    );
    assert!(
        fresh_png.exists(),
        "clipboard png within its TTL must survive the sweep"
    );
    assert!(
        unrelated.exists(),
        "a file outside the clipboard-*.png / *.tmp shapes must never be touched"
    );
}

#[test]
fn sweep_never_removes_a_directory_even_if_it_matches_the_shape() {
    let _home = HomeGuard::new();
    let dir = session::agent_desktop_dir().unwrap().join("tmp");
    let fake_dir = dir.join("clipboard-0-0-0.png");
    std::fs::create_dir_all(&fake_dir).unwrap();

    remove_stale_files_in_dir(&dir, Duration::ZERO, is_clipboard_image_file);

    assert!(
        fake_dir.is_dir(),
        "the sweep must never remove a directory, even one matching the file shape"
    );
}

#[test]
fn consecutive_sessionless_image_captures_keep_the_prior_capture() {
    let _home = HomeGuard::new();
    let first_double = LocalDouble::returning(Ok(Some(ClipboardContent::Image(ImageBuffer {
        data: vec![1],
        format: crate::ImageFormat::Png,
        width: 1,
        height: 1,
        scale_factor: 1.0,
    }))));
    let first = execute(
        ClipboardGetArgs {
            format: Some(ClipboardFormat::Image),
            out: None,
        },
        &first_double,
        &no_session_context(),
    )
    .unwrap();
    let first_path = PathBuf::from(first["path"].as_str().unwrap());

    let second_double = LocalDouble::returning(Ok(Some(ClipboardContent::Image(ImageBuffer {
        data: vec![2],
        format: crate::ImageFormat::Png,
        width: 1,
        height: 1,
        scale_factor: 1.0,
    }))));
    let _ = execute(
        ClipboardGetArgs {
            format: Some(ClipboardFormat::Image),
            out: None,
        },
        &second_double,
        &no_session_context(),
    )
    .unwrap();

    assert!(
        first_path.exists(),
        "a clipboard image captured moments ago must not be pruned by the very next capture"
    );
}

#[test]
fn image_variant_without_out_prunes_stale_sessionless_artifacts() {
    let _home = HomeGuard::new();
    let dir = session::agent_desktop_dir().unwrap().join("tmp");
    std::fs::create_dir_all(&dir).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        for path in [dir.parent().unwrap(), dir.as_path()] {
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
    }

    let stale_png = dir.join("clipboard-9-9-0.png");
    let stale_tmp = dir.join("orphan.tmp");
    let unrelated = dir.join("keep.txt");
    write_with_age(
        &stale_png,
        b"old capture",
        CLIPBOARD_IMAGE_MAX_AGE + Duration::from_secs(1),
    );
    write_with_age(
        &stale_tmp,
        b"old",
        STALE_TMP_MAX_AGE + Duration::from_secs(1),
    );
    write_with_age(
        &unrelated,
        b"keep",
        CLIPBOARD_IMAGE_MAX_AGE + Duration::from_secs(1),
    );

    let double = LocalDouble::returning(Ok(Some(ClipboardContent::Image(ImageBuffer {
        data: vec![7, 7, 7],
        format: crate::ImageFormat::Png,
        width: 1,
        height: 1,
        scale_factor: 1.0,
    }))));
    let out = execute(
        ClipboardGetArgs {
            format: Some(ClipboardFormat::Image),
            out: None,
        },
        &double,
        &no_session_context(),
    )
    .unwrap();
    let new_path = PathBuf::from(out["path"].as_str().unwrap());

    assert!(
        new_path.exists(),
        "the image just written by this call must survive its own write"
    );
    assert!(
        !stale_png.exists(),
        "a stale clipboard png must be pruned by the next capture"
    );
    assert!(
        !stale_tmp.exists(),
        "a stale orphaned tmp file must be pruned by the next capture"
    );
    assert!(
        unrelated.exists(),
        "a non-matching file must never be touched"
    );
}

#[cfg(unix)]
#[test]
fn image_variant_without_out_writes_private_0600_file_under_session_dir() {
    use std::os::unix::fs::PermissionsExt;

    let _home = HomeGuard::new();
    let context = CommandContext::new(Some("clip-get-test-session".into()), None, false).unwrap();

    let double = LocalDouble::returning(Ok(Some(ClipboardContent::Image(ImageBuffer {
        data: vec![9, 9, 9],
        format: crate::ImageFormat::Png,
        width: 3,
        height: 3,
        scale_factor: 1.0,
    }))));
    let out = execute(
        ClipboardGetArgs {
            format: Some(ClipboardFormat::Image),
            out: None,
        },
        &double,
        &context,
    )
    .unwrap();

    let path = out["path"].as_str().expect("path field").to_string();
    let session_dir = session::session_dir("clip-get-test-session")
        .unwrap()
        .join("clipboard");
    assert!(
        std::path::Path::new(&path).starts_with(&session_dir),
        "default image path {path} must live under the session's clipboard dir {}",
        session_dir.display()
    );
    let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
    assert_eq!(
        mode, 0o600,
        "clipboard image temp file must be 0600, got {mode:o}"
    );
}
