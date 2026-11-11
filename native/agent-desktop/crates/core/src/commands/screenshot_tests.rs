use crate::{
    AdapterError, ImageBuffer, ImageFormat, Rect, WindowInfo,
    adapter::{ActionOps, InputOps, ObservationOps, ScreenshotTarget, SystemOps, WindowFilter},
    commands::screenshot::{self, ScreenshotArgs},
    system::display_info::DisplayInfo,
};
use std::{path::PathBuf, sync::Mutex};

struct ScreenshotAdapter {
    displays: Vec<DisplayInfo>,
    windows: Vec<WindowInfo>,
    target: Mutex<Option<ScreenshotTarget>>,
    stopped: bool,
}

impl ScreenshotAdapter {
    fn new() -> Self {
        let mut focused = window("w-42", 700);
        focused.state.is_focused = true;
        Self {
            displays: vec![display("main", true, 2.0), display("secondary", false, 1.0)],
            windows: vec![window("w-41", 700), focused],
            target: Mutex::new(None),
            stopped: false,
        }
    }

    fn take_target(&self) -> Option<ScreenshotTarget> {
        self.target.lock().expect("target lock").take()
    }
}

impl ObservationOps for ScreenshotAdapter {
    fn list_apps(&self, _deadline: crate::Deadline) -> Result<Vec<crate::AppInfo>, AdapterError> {
        Ok(vec![crate::AppInfo {
            name: "Example".into(),
            pid: crate::ProcessId::new(700),
            bundle_id: Some("com.example.app".into()),
            process_instance: Some("instance-700".into()),
            presentation: None,
        }])
    }

    fn list_windows(
        &self,
        _filter: &WindowFilter,
        _deadline: crate::Deadline,
    ) -> Result<Vec<WindowInfo>, AdapterError> {
        Ok(self.windows.clone())
    }
}

impl ActionOps for ScreenshotAdapter {}
impl InputOps for ScreenshotAdapter {}

impl SystemOps for ScreenshotAdapter {
    fn screenshot(
        &self,
        target: ScreenshotTarget,
        _deadline: crate::Deadline,
    ) -> Result<ImageBuffer, AdapterError> {
        *self.target.lock().expect("target lock") = Some(target);
        Ok(ImageBuffer {
            data: vec![1, 2, 3],
            format: ImageFormat::Png,
            width: 640,
            height: 480,
            scale_factor: 2.0,
        })
    }

    fn list_displays(&self, _deadline: crate::Deadline) -> Result<Vec<DisplayInfo>, AdapterError> {
        Ok(self.displays.clone())
    }

    fn process_state(
        &self,
        _process: crate::ProcessIdentity,
        _deadline: crate::Deadline,
    ) -> Result<crate::system::process_state::ProcessState, AdapterError> {
        Ok(if self.stopped {
            crate::system::process_state::ProcessState::Unresponsive
        } else {
            crate::system::process_state::ProcessState::Running
        })
    }
}

fn display(id: &str, is_primary: bool, scale: f64) -> DisplayInfo {
    DisplayInfo {
        id: id.into(),
        bounds: Rect {
            x: 0.0,
            y: 0.0,
            width: 1440.0,
            height: 900.0,
        },
        is_primary,
        scale,
    }
}

fn window(id: &str, pid: u32) -> WindowInfo {
    WindowInfo {
        id: id.into(),
        title: format!("Window {id}"),
        app: "Example".into(),
        pid: crate::ProcessId::new(pid),
        process_instance: Some(format!("instance-{pid}")),
        bounds: None,
        state: crate::WindowState {
            is_focused: false,
            ..Default::default()
        },
    }
}

fn args() -> ScreenshotArgs {
    ScreenshotArgs {
        app: None,
        window_id: None,
        screen: None,
        output_path: None,
    }
}

#[test]
fn screen_target_pins_selected_display_identity() {
    let adapter = ScreenshotAdapter::new();
    let mut request = args();
    request.screen = Some(1);

    screenshot::execute(request, &adapter).expect("screenshot");

    match adapter.take_target() {
        Some(ScreenshotTarget::Display { index, expected }) => {
            assert_eq!(index, 1);
            assert_eq!(expected.id, "secondary");
            assert_eq!(expected.scale, 1.0);
        }
        _ => panic!("expected identity-pinned display target"),
    }
}

#[test]
fn screen_rejects_app_and_window_target_conflicts() {
    for (app, window_id) in [
        (Some("Example".into()), None),
        (None, Some("w-42".into())),
        (Some("Example".into()), Some("w-42".into())),
    ] {
        let adapter = ScreenshotAdapter::new();
        let mut request = args();
        request.screen = Some(0);
        request.app = app;
        request.window_id = window_id;

        let error = screenshot::execute(request, &adapter).expect_err("targets conflict");
        assert_eq!(error.code(), "INVALID_ARGS");
        assert!(adapter.take_target().is_none());
    }
}

#[test]
fn window_id_target_pins_exact_window_not_only_its_pid() {
    let adapter = ScreenshotAdapter::new();
    let mut request = args();
    request.window_id = Some("w-42".into());

    screenshot::execute(request, &adapter).expect("screenshot");

    match adapter.take_target() {
        Some(ScreenshotTarget::ExactWindow(window)) => {
            assert_eq!(window.id, "w-42");
            assert_eq!(window.pid, 700);
        }
        _ => panic!("expected exact window target"),
    }
}

#[test]
fn app_target_resolves_one_exact_focused_window() {
    let adapter = ScreenshotAdapter::new();
    let mut request = args();
    request.app = Some("Example".into());

    screenshot::execute(request, &adapter).expect("screenshot");

    match adapter.take_target() {
        Some(ScreenshotTarget::ExactWindow(window)) => {
            assert_eq!(window.id, "w-42");
            assert_eq!(window.process_instance.as_deref(), Some("instance-700"));
        }
        _ => panic!("expected exact window target"),
    }
}

#[test]
fn missing_window_returns_an_error_without_capturing() {
    let adapter = ScreenshotAdapter::new();
    let mut request = args();
    request.window_id = Some("w-404".into());

    let error = screenshot::execute(request, &adapter).expect_err("missing window");

    assert_eq!(error.code(), "WINDOW_NOT_FOUND");
    assert!(adapter.take_target().is_none());
}

#[test]
fn missing_window_of_a_stopped_app_is_unresponsive_not_missing() {
    let mut adapter = ScreenshotAdapter::new();
    adapter.stopped = true;
    adapter.windows.clear();
    let mut request = args();
    request.app = Some("Example".into());
    request.window_id = Some("w-42".into());

    let error = screenshot::execute(request, &adapter).expect_err("stopped app");

    assert_eq!(error.code(), "APP_UNRESPONSIVE");
    assert!(adapter.take_target().is_none());
}

#[test]
fn argument_and_target_errors_carry_a_suggestion_and_a_safe_disposition() {
    let mut out_of_range = args();
    out_of_range.screen = Some(9);
    let mut missing_window = args();
    missing_window.window_id = Some("w-404".into());

    for request in [out_of_range, missing_window] {
        let error = screenshot::execute(request, &ScreenshotAdapter::new())
            .expect_err("the target does not exist");
        let crate::AppError::Adapter(adapter) = error else {
            panic!("an adapter error");
        };
        assert!(
            adapter.suggestion.is_some(),
            "{} carries no suggestion",
            adapter.message
        );
        assert_eq!(
            adapter.disposition,
            crate::DeliverySemantics::not_delivered()
        );
    }
}

#[test]
fn incomplete_process_identity_carries_a_suggestion_and_a_safe_disposition() {
    let mut incomplete = window("w-42", 700);
    incomplete.process_instance = None;
    let adapter = ScreenshotAdapter {
        displays: vec![display("main", true, 2.0)],
        windows: vec![incomplete],
        target: Mutex::new(None),
        stopped: false,
    };
    let mut request = args();
    request.window_id = Some("w-42".into());

    let error =
        screenshot::execute(request, &adapter).expect_err("the process identity is incomplete");

    assert_eq!(error.code(), "ACTION_NOT_SUPPORTED");
    let crate::AppError::Adapter(adapter_error) = error else {
        panic!("an adapter error");
    };
    assert_eq!(
        adapter_error.suggestion.as_deref(),
        Some("Refresh the target with 'list-windows', then retry")
    );
    assert_eq!(
        adapter_error.disposition,
        crate::DeliverySemantics::not_delivered()
    );
    assert!(adapter.take_target().is_none());
}

#[test]
fn output_path_response_keeps_image_metadata() {
    let adapter = ScreenshotAdapter::new();
    let path = output_path();
    let mut request = args();
    request.output_path = Some(path.clone());

    let response = screenshot::execute(request, &adapter).expect("screenshot");

    assert_eq!(std::fs::read(&path).expect("saved screenshot"), [1, 2, 3]);
    assert_eq!(response["path"], path.to_string_lossy().as_ref());
    assert_eq!(response["format"], "png");
    assert_eq!(response["width"], 640);
    assert_eq!(response["height"], 480);
    assert_eq!(response["scale_factor"], 2.0);
    std::fs::remove_file(path).expect("remove screenshot");
}

#[cfg(unix)]
#[test]
fn output_path_rejects_symlinks_and_creates_private_files() {
    use std::os::unix::fs::{MetadataExt, PermissionsExt, symlink};

    let parent = std::env::temp_dir().join(format!(
        "agent-desktop-core-screenshot-private-{}-{:?}",
        std::process::id(),
        std::thread::current().id()
    ));
    std::fs::create_dir_all(&parent).expect("create private output directory");
    std::fs::set_permissions(&parent, std::fs::Permissions::from_mode(0o700))
        .expect("secure output directory");
    let victim = parent.join("victim.png");
    let link = parent.join("screenshot.png");
    std::fs::write(&victim, b"unchanged").expect("write victim");
    symlink(&victim, &link).expect("create output symlink");

    let mut request = args();
    request.output_path = Some(link);
    screenshot::execute(request, &ScreenshotAdapter::new()).expect_err("reject symlink");
    assert_eq!(std::fs::read(&victim).expect("read victim"), b"unchanged");

    let output = parent.join("private.png");
    let mut request = args();
    request.output_path = Some(output.clone());
    screenshot::execute(request, &ScreenshotAdapter::new()).expect("write private screenshot");
    assert_eq!(
        std::fs::metadata(output).expect("output metadata").mode() & 0o777,
        0o600
    );
    std::fs::remove_file(parent.join("screenshot.png")).expect("remove symlink");
    std::fs::remove_file(parent.join("victim.png")).expect("remove victim");
    std::fs::remove_file(parent.join("private.png")).expect("remove output");
    std::fs::remove_dir(parent).expect("remove output directory");
}

fn output_path() -> PathBuf {
    std::env::temp_dir().join(format!(
        "agent-desktop-core-screenshot-{}-{:?}.png",
        std::process::id(),
        std::thread::current().id()
    ))
}

#[path = "screenshot_output_tests.rs"]
mod output_tests;
