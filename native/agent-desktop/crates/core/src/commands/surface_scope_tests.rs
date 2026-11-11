use super::reject_root_with_surface;
use crate::SnapshotSurface;

struct ScopedSurface;

impl crate::ObservationOps for ScopedSurface {
    fn list_windows(
        &self,
        _filter: &crate::WindowFilter,
        _deadline: crate::Deadline,
    ) -> Result<Vec<crate::WindowInfo>, crate::AdapterError> {
        Err(crate::AdapterError::new(
            crate::ErrorCode::ElementNotFound,
            "observation reached",
        ))
    }
}
impl crate::ActionOps for ScopedSurface {}
impl crate::InputOps for ScopedSurface {}
impl crate::SystemOps for ScopedSurface {
    fn check_surface_support(&self, requested: SnapshotSurface) -> Result<(), crate::AdapterError> {
        assert_eq!(requested, SnapshotSurface::Window);
        Ok(())
    }

    fn supported_surfaces(&self) -> Vec<SnapshotSurface> {
        panic!("a supported request must not discover unrelated surfaces")
    }
}

#[test]
fn supported_surface_requests_do_not_discover_unrelated_capabilities() {
    let context = crate::CommandContext::default();
    let snapshot = crate::commands::snapshot::execute(
        crate::commands::snapshot::SnapshotArgs {
            app: None,
            window_id: None,
            max_depth: 10,
            include_bounds: false,
            interactive_only: false,
            compact: false,
            surface: SnapshotSurface::Window,
            skeleton: false,
            root_ref: None,
            timeout_ms: None,
            force_electron_a11y: false,
        },
        &ScopedSurface,
        &context,
    )
    .unwrap_err();
    let find = crate::commands::find::execute(
        crate::commands::find::FindArgs {
            app: None,
            window_id: None,
            root: None,
            surface: SnapshotSurface::Window,
            filter: crate::commands::find::FindFilterArgs {
                role: Some("button".into()),
                name: None,
                description: None,
                native_id: None,
                value: None,
                text: None,
                exact: false,
            },
            states: Vec::new(),
            selection: crate::commands::find::FindSelectionArgs {
                count: true,
                first: false,
                last: false,
                nth: None,
                limit: None,
            },
            timeout_ms: None,
        },
        &ScopedSurface,
        &context,
    )
    .unwrap_err();
    for error in [snapshot, find] {
        assert_eq!(error.code(), "ELEMENT_NOT_FOUND");
        assert!(error.to_string().contains("observation reached"));
    }
}

#[test]
fn a_ref_root_may_keep_the_default_window_surface() {
    assert!(reject_root_with_surface("find", Some("@s1:e2"), SnapshotSurface::Window).is_ok());
}

#[test]
fn a_ref_root_rejects_an_explicit_second_surface() {
    let error = reject_root_with_surface("find", Some("@s1:e2"), SnapshotSurface::Menubar)
        .expect_err("a ref already carries its surface");
    assert!(error.to_string().contains("--surface"));
}

#[test]
fn a_surface_without_a_root_is_allowed() {
    assert!(reject_root_with_surface("find", None, SnapshotSurface::Menubar).is_ok());
}
