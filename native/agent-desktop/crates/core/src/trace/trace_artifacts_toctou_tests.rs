use super::tests::{artifacts_session, entry, setup_artifacts_test};
use crate::{
    AdapterError, ErrorCode, ImageBuffer, ImageFormat,
    actions::action::Action,
    actions::action_request::ActionRequest,
    actions::action_result::ActionResult,
    adapter::{
        ActionOps, InputOps, LiveElement, NativeHandle, ObservationOps, ScreenshotTarget, SystemOps,
    },
    context::CommandContext,
    ref_action::{ResolvedRefAction, execute_resolved},
    tree::element_state::ElementState,
};
use std::sync::atomic::{AtomicU32, Ordering};

struct ScreenshotMutationAdapter {
    live_reads: AtomicU32,
    dispatches: AtomicU32,
}

impl ObservationOps for ScreenshotMutationAdapter {
    fn resolve_element_strict(
        &self,
        _entry: &crate::RefEntry,
        _deadline: crate::Deadline,
    ) -> Result<NativeHandle, AdapterError> {
        Ok(NativeHandle::null())
    }

    fn get_element_bounds(
        &self,
        _handle: &NativeHandle,
        _deadline: crate::Deadline,
    ) -> Result<Option<crate::Rect>, AdapterError> {
        Ok(Some(crate::Rect {
            x: 1.0,
            y: 1.0,
            width: 20.0,
            height: 20.0,
        }))
    }

    fn get_live_element(
        &self,
        _handle: &NativeHandle,
        _deadline: crate::Deadline,
    ) -> Result<LiveElement, AdapterError> {
        let read = self.live_reads.fetch_add(1, Ordering::SeqCst) + 1;
        let states = if read == 1 {
            Vec::new()
        } else {
            vec!["disabled".into()]
        };
        Ok(LiveElement {
            identity: crate::adapter::live_identity("Run"),
            state: ElementState {
                role: "button".into(),
                states,
                value: None,
                enabled: Some(read == 1),
                hidden: Some(false),
                offscreen: Some(false),
            },
            states_complete: true,
            bounds: Some(crate::Rect {
                x: 1.0,
                y: 1.0,
                width: 20.0,
                height: 20.0,
            }),
            available_actions: vec![crate::actions::capability::CLICK.into()],
        })
    }

    fn hit_test(
        &self,
        _handle: &NativeHandle,
        _point: crate::Point,
        _deadline: crate::Deadline,
    ) -> Result<crate::adapter::hit_test::HitTestResult, AdapterError> {
        Ok(crate::adapter::hit_test::HitTestResult::ReachesTarget)
    }
}

impl ActionOps for ScreenshotMutationAdapter {
    fn execute_action(
        &self,
        _handle: &NativeHandle,
        _request: ActionRequest,
        _lease: &crate::InteractionLease,
    ) -> Result<ActionResult, AdapterError> {
        self.dispatches.fetch_add(1, Ordering::SeqCst);
        Ok(ActionResult::delivered_unverified("click"))
    }
}

impl InputOps for ScreenshotMutationAdapter {}

impl SystemOps for ScreenshotMutationAdapter {
    crate::adapter::guarded_interaction_lease!();

    fn screenshot(
        &self,
        _target: ScreenshotTarget,
        _deadline: crate::Deadline,
    ) -> Result<ImageBuffer, AdapterError> {
        Ok(ImageBuffer {
            data: vec![1],
            format: ImageFormat::Png,
            width: 1,
            height: 1,
            scale_factor: 1.0,
        })
    }
}

#[test]
fn full_artifact_capture_is_followed_by_final_preflight() {
    let (_home, _lock) = setup_artifacts_test();
    let manifest = artifacts_session();
    let context = CommandContext::new(Some(manifest.id), None, false).unwrap();
    let adapter = ScreenshotMutationAdapter {
        live_reads: AtomicU32::new(0),
        dispatches: AtomicU32::new(0),
    };
    let entry = entry(1);
    let deadline = crate::Deadline::standard().unwrap();
    let lease = adapter.acquire_interaction_lease(deadline).unwrap();
    let handle = NativeHandle::null();
    let target = crate::ref_action::ref_action_context::RefActionContext::new(
        crate::ref_action::ref_action_wait_context::RefActionWaitContext {
            adapter: &adapter,
            entry: &entry,
            ref_id: "@e1",
            context: &context,
        },
        deadline,
    );
    let err = execute_resolved(
        ResolvedRefAction::new(target, &handle),
        ActionRequest::headless(Action::Click),
        &lease,
    )
    .unwrap_err();
    assert_eq!(err.code(), "ACTION_FAILED");
    assert_eq!(adapter.live_reads.load(Ordering::SeqCst), 2);
    assert_eq!(adapter.dispatches.load(Ordering::SeqCst), 0);
    let crate::AppError::Adapter(adapter_error) = err else {
        panic!("expected adapter error");
    };
    assert_eq!(adapter_error.code, ErrorCode::ActionFailed);
}

#[test]
fn oversized_screenshot_is_not_embedded() {
    let directory = std::env::temp_dir().join(format!(
        "agent-desktop-oversized-screen-{}",
        crate::refs::new_snapshot_id()
    ));
    std::fs::create_dir_all(&directory).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    let path = directory.join("screen.png");
    crate::refs::write_private_file(&path, b"png").unwrap();
    std::fs::OpenOptions::new()
        .write(true)
        .open(&path)
        .unwrap()
        .set_len(super::MAX_EMBED_SCREENSHOT_BYTES + 1)
        .unwrap();

    assert!(super::read_screenshot_for_embed(&directory, "screen.png").is_none());

    std::fs::remove_dir_all(directory).unwrap();
}

#[cfg(unix)]
#[test]
fn screenshot_fifo_is_rejected_without_blocking() {
    use std::ffi::CString;

    let directory = std::env::temp_dir().join(format!(
        "agent-desktop-fifo-screen-{}",
        crate::refs::new_snapshot_id()
    ));
    std::fs::create_dir_all(&directory).unwrap();
    let path = directory.join("screen.png");
    let c_path = CString::new(path.to_string_lossy().as_bytes()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(c_path.as_ptr(), 0o600) }, 0);
    let started = std::time::Instant::now();

    assert!(super::read_screenshot_for_embed(&directory, "screen.png").is_none());
    assert!(started.elapsed() < std::time::Duration::from_secs(1));

    std::fs::remove_dir_all(directory).unwrap();
}
