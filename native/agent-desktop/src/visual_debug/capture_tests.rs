use super::*;
use agent_desktop_core::{ActionOps, ImageBuffer, InputOps, ObservationOps, ProcessId, SystemOps};
use std::sync::atomic::{AtomicUsize, Ordering};

#[derive(Default)]
struct CaptureAdapter {
    reads: AtomicUsize,
    move_after_capture: bool,
    invalid_format: bool,
    oversized: bool,
}

impl ActionOps for CaptureAdapter {}
impl InputOps for CaptureAdapter {}
impl ObservationOps for CaptureAdapter {
    fn resolve_element_strict(
        &self,
        _: &RefEntry,
        _: Deadline,
    ) -> Result<agent_desktop_core::NativeHandle, AdapterError> {
        Ok(agent_desktop_core::NativeHandle::null())
    }
    fn get_element_bounds(
        &self,
        _: &agent_desktop_core::NativeHandle,
        _: Deadline,
    ) -> Result<Option<Rect>, AdapterError> {
        Ok(window().bounds)
    }
}
impl SystemOps for CaptureAdapter {
    fn resolve_window_strict(
        &self,
        expected: &WindowInfo,
        _: Deadline,
    ) -> Result<WindowInfo, AdapterError> {
        assert_eq!(expected.id, "w-test");
        assert_eq!(expected.process_instance.as_deref(), Some("test-instance"));
        let mut window = WindowInfo {
            bounds: window().bounds,
            ..expected.clone()
        };
        if self.reads.fetch_add(1, Ordering::Relaxed) > 0 && self.move_after_capture {
            window.bounds.as_mut().unwrap().x += 10.0;
        }
        Ok(window)
    }

    fn screenshot_window_frame(
        &self,
        window: &WindowInfo,
        _: Deadline,
    ) -> Result<ImageBuffer, AdapterError> {
        assert_eq!(window.id, "w-test");
        Ok(ImageBuffer {
            data: if self.oversized {
                vec![0; 64 * 1024 * 1024 + 1]
            } else {
                vec![1, 2, 3]
            },
            format: if self.invalid_format {
                ImageFormat::Jpg
            } else {
                ImageFormat::Png
            },
            width: 1200,
            height: 800,
            scale_factor: 2.0,
        })
    }
}

fn window() -> WindowInfo {
    WindowInfo {
        id: "w-test".into(),
        title: "Test".into(),
        app: "Fixture".into(),
        pid: ProcessId::new(5),
        process_instance: Some("test-instance".into()),
        bounds: Some(Rect {
            x: -1000.0,
            y: 100.0,
            width: 600.0,
            height: 400.0,
        }),
        state: WindowState::default(),
    }
}

#[test]
fn visual_debug_capture_preserves_global_origin_and_retina_frame() {
    let adapter = CaptureAdapter {
        reads: AtomicUsize::new(0),
        move_after_capture: false,
        ..Default::default()
    };
    let frame = capture_frame(&window(), &adapter, Deadline::standard().unwrap()).unwrap();
    assert_eq!(frame["width"], 1200);
    assert_eq!(frame["window"]["bounds"]["x"], -1000.0);
    assert_eq!(frame["image"], "data:image/png;base64,AQID");
    assert_eq!(adapter.reads.load(Ordering::Relaxed), 2);
}

#[test]
fn visual_debug_capture_rejects_window_motion() {
    let adapter = CaptureAdapter {
        reads: AtomicUsize::new(0),
        move_after_capture: true,
        ..Default::default()
    };
    assert!(
        capture_frame(&window(), &adapter, Deadline::standard().unwrap())
            .unwrap_err()
            .to_string()
            .contains("moved")
    );
}

#[test]
fn saved_snapshot_and_click_capture_use_exact_source_evidence() {
    if std::env::var_os("VISUAL_DEBUG_CAPTURE_TEST_CHILD").is_none() {
        let home = std::env::temp_dir().join(format!(
            "debug-capture-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&home).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&home, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "visual_debug::capture::tests::saved_snapshot_and_click_capture_use_exact_source_evidence", "--nocapture"])
            .env("VISUAL_DEBUG_CAPTURE_TEST_CHILD", "1").env("AGENT_DESKTOP_HOME", &home).output().unwrap();
        std::fs::remove_dir_all(home).unwrap();
        assert!(
            output.status.success(),
            "{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(
            String::from_utf8_lossy(&output.stdout).contains("1 passed; 0 failed"),
            "the child must execute exactly one test: stdout={} stderr={}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        return;
    }
    let window = window();
    let entry: RefEntry = serde_json::from_value(json!({
        "pid": 5, "process_instance": "test-instance", "role": "button", "name": "Save",
        "path": [0], "source_surface": "window", "source_window_id": "w-test",
        "source_window_bounds_hash": window.bounds.unwrap().bounds_hash(),
        "states": [], "available_actions": ["Click"], "bounds": window.bounds,
        "bounds_hash": window.bounds.unwrap().bounds_hash()
    }))
    .unwrap();
    let mut refs = agent_desktop_core::refs::RefMap::new();
    refs.try_allocate(entry).unwrap();
    RefStore::new()
        .unwrap()
        .save_snapshot("sfixture", &refs)
        .unwrap();
    let adapter = CaptureAdapter::default();
    let context = CommandContext::default();
    let mut data =
        json!({"window": {"id": "w-test"}, "tree": {"role": "button", "ref_id": "@sfixture:e1"}});
    assert_eq!(
        snapshot_frame(&data, &adapter, &context).unwrap()["nodes"][0]["ref_id"],
        "@sfixture:e1"
    );
    data["window"]["id"] = "w-other".into();
    assert!(
        matches!(snapshot_frame(&data, &adapter, &context), Err(AppError::Adapter(error)) if error.code == agent_desktop_core::ErrorCode::StaleRef)
    );
    use clap::Parser;
    let crate::cli::Commands::Click(args) =
        crate::Cli::try_parse_from(["agent-desktop", "click", "@sfixture:e1"])
            .unwrap()
            .command
            .unwrap()
    else {
        panic!()
    };
    let (_, frame) = click_before(&args, &adapter, &context).unwrap();
    assert_eq!(frame["nodes"][0]["kind"], "target");
    assert_eq!(frame["nodes"][0]["bounds"], json!(window.bounds));
}

#[test]
fn capture_rejects_non_png_and_oversized_images() {
    for (invalid_format, oversized) in [(true, false), (false, true)] {
        let adapter = CaptureAdapter {
            invalid_format,
            oversized,
            ..Default::default()
        };
        let error = capture_frame(&window(), &adapter, Deadline::standard().unwrap()).unwrap_err();
        assert!(error.to_string().contains("PNG no larger than 64 MiB"));
    }
}

#[test]
fn capture_requires_exact_window_and_process_evidence() {
    let mut entry: RefEntry = serde_json::from_value(json!({
        "pid": 5, "role": "button", "path": [], "source_surface": "window",
        "states": [], "available_actions": []
    }))
    .unwrap();
    let adapter = CaptureAdapter::default();
    assert!(
        window_for_entry(&entry, &adapter, Deadline::standard().unwrap())
            .unwrap_err()
            .to_string()
            .contains("exact source window")
    );
    entry.source.source_window_id = Some("w-test".into());
    assert!(
        window_for_entry(&entry, &adapter, Deadline::standard().unwrap())
            .unwrap_err()
            .to_string()
            .contains("process instance")
    );
    entry.process.process_instance = Some(String::new());
    assert!(window_for_entry(&entry, &adapter, Deadline::standard().unwrap()).is_err());
    assert_eq!(adapter.reads.load(Ordering::Relaxed), 0);
}

#[test]
fn snapshot_without_an_addressable_ref_never_captures_a_guessed_window() {
    let adapter = CaptureAdapter::default();
    let error = snapshot_frame(
        &json!({"tree": {"role": "window"}}),
        &adapter,
        &CommandContext::default(),
    )
    .unwrap_err();
    assert!(error.to_string().contains("No returned ref"));
    assert_eq!(adapter.reads.load(Ordering::Relaxed), 0);
}

#[test]
fn visual_debug_frame_rejects_padding_and_empty_geometry() {
    let bounds = window().bounds.unwrap();
    assert!(validate_frame(bounds, 1200, 800).is_ok());
    assert!(validate_frame(bounds, 1320, 920).is_err());
    assert!(validate_frame(bounds, 0, 800).is_err());
    assert!(
        validate_frame(
            Rect {
                width: 0.0,
                ..bounds
            },
            1200,
            800
        )
        .is_err()
    );
}
