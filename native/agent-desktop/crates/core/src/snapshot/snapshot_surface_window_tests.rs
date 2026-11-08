use super::*;
use crate::adapter::{ActionOps, InputOps, ObservationOps, SystemOps};

struct SurfaceAdapter {
    windows: Vec<WindowInfo>,
    surface_on: &'static str,
}

impl ObservationOps for SurfaceAdapter {
    fn list_windows(
        &self,
        filter: &WindowFilter,
        _deadline: crate::Deadline,
    ) -> Result<Vec<WindowInfo>, crate::AdapterError> {
        Ok(self
            .windows
            .iter()
            .filter(|window| !filter.focused_only || window.state.is_focused)
            .cloned()
            .collect())
    }

    fn observe_tree(
        &self,
        root: ObservationRoot<'_>,
        _request: &ObservationRequest,
    ) -> Result<crate::locator::live_locator::ObservedTree, crate::AdapterError> {
        let ObservationRoot::Window(window) = root else {
            panic!("a snapshot observes a window root");
        };
        if !window.state.accessible {
            return Err(crate::AdapterError::new(
                crate::ErrorCode::ActionNotSupported,
                "Window exists but is not exposed through accessibility",
            ));
        }
        if window.id != self.surface_on {
            return Err(crate::AdapterError::new(
                crate::ErrorCode::ElementNotFound,
                "No open alert in this window",
            ));
        }
        crate::adapter::observed_tree(
            &root,
            AccessibilityNode {
                ref_id: None,
                role: "sheet".into(),
                identity: Default::default(),
                presentation: Default::default(),
                children_count: None,
                subtree_truncated: false,
                children: Vec::new(),
            },
        )
    }
}

impl ActionOps for SurfaceAdapter {}
impl InputOps for SurfaceAdapter {}
impl SystemOps for SurfaceAdapter {
    fn supported_surfaces(&self) -> Vec<crate::SnapshotSurface> {
        vec![crate::SnapshotSurface::Sheet, crate::SnapshotSurface::Alert]
    }
}

fn app_window(id: &str, focused: bool) -> WindowInfo {
    WindowInfo {
        id: id.into(),
        state: crate::WindowState {
            is_focused: focused,
            visible: Some(true),
            ..Default::default()
        },
        title: "TextEdit".into(),
        app: "TextEdit".into(),
        pid: crate::ProcessId::new(10),
        process_instance: Some("instance-10".into()),
        bounds: None,
    }
}

fn alert_options() -> TreeOptions {
    TreeOptions {
        surface: crate::SnapshotSurface::Alert,
        ..Default::default()
    }
}

#[test]
fn an_unpinned_alert_is_found_on_whichever_window_holds_it() {
    let mut sheet_window = app_window("w-sheet", false);
    sheet_window.state.accessible = false;
    let adapter = SurfaceAdapter {
        windows: vec![
            sheet_window,
            app_window("w-1", true),
            app_window("w-2", false),
        ],
        surface_on: "w-2",
    };

    let result = build(
        &adapter,
        &alert_options(),
        Some("TextEdit"),
        None,
        crate::Deadline::after(1_000).unwrap(),
    )
    .unwrap();

    assert_eq!(result.window.id, "w-2");
}

#[test]
fn a_pinned_window_never_reads_another_windows_alert() {
    let adapter = SurfaceAdapter {
        windows: vec![app_window("w-1", true), app_window("w-2", false)],
        surface_on: "w-2",
    };

    let error = build(
        &adapter,
        &alert_options(),
        Some("TextEdit"),
        Some("w-1"),
        crate::Deadline::after(1_000).unwrap(),
    )
    .err()
    .expect("the pinned window has no alert");

    assert_eq!(error.code(), "ELEMENT_NOT_FOUND");
}

#[test]
fn an_alert_without_app_is_found_on_another_window_of_the_frontmost_app() {
    let mut other_process = app_window("w-9", false);
    other_process.pid = crate::ProcessId::new(99);
    let adapter = SurfaceAdapter {
        windows: vec![
            app_window("w-1", true),
            other_process,
            app_window("w-2", false),
        ],
        surface_on: "w-2",
    };

    let result = build(
        &adapter,
        &alert_options(),
        None,
        None,
        crate::Deadline::after(1_000).unwrap(),
    )
    .unwrap();

    assert_eq!(result.window.id, "w-2");
}

#[test]
fn find_and_snapshot_reach_the_same_sheet_and_respect_an_explicit_window() {
    use crate::commands::find::{FindArgs, FindFilterArgs, FindSelectionArgs};

    let adapter = SurfaceAdapter {
        windows: vec![app_window("w-main", true), app_window("w-sheet", false)],
        surface_on: "w-sheet",
    };
    let options = TreeOptions {
        surface: crate::SnapshotSurface::Sheet,
        ..Default::default()
    };
    for app in [None, Some("TextEdit")] {
        let snapshot = build(
            &adapter,
            &options,
            app,
            None,
            crate::Deadline::standard().unwrap(),
        )
        .expect("snapshot reaches the sheet window");
        assert_eq!(snapshot.window.id, "w-sheet");
        for window in [None, Some("w-main")] {
            let result = crate::commands::find::execute(
                FindArgs {
                    app: app.map(str::to_owned),
                    window_id: window.map(str::to_owned),
                    root: None,
                    surface: crate::SnapshotSurface::Sheet,
                    filter: FindFilterArgs {
                        role: Some("sheet".into()),
                        name: None,
                        description: None,
                        native_id: None,
                        value: None,
                        text: None,
                        exact: true,
                    },
                    states: Vec::new(),
                    selection: FindSelectionArgs {
                        count: true,
                        first: false,
                        last: false,
                        nth: None,
                        limit: None,
                    },
                    timeout_ms: None,
                },
                &adapter,
                &CommandContext::default(),
            );
            if window.is_some() {
                assert_eq!(
                    result.expect_err("the pinned window has no sheet").code(),
                    "ELEMENT_NOT_FOUND"
                );
            } else {
                assert_eq!(result.expect("find reaches the same sheet")["count"], 1);
            }
        }
    }
}
