use super::*;
use crate::AdapterError;
use crate::actions::action::Action;
use crate::actions::action_request::ActionRequest;
use crate::actions::action_result::ActionResult;
use crate::adapter::{
    ActionOps, InputOps, NativeHandle, ObservationOps, PlatformAdapter, ScreenshotTarget, SystemOps,
};
use crate::context::CommandContext;
use crate::ref_action::{ResolvedRefAction, execute_resolved};
use crate::refs::refs_store::RefStore;
use crate::refs::refs_test_support::HomeGuard;
use crate::session::{ArtifactsMode, SessionTraceMode, StartSessionOptions, start_session};
use crate::trace::trace_artifacts::clear_test_budgets;
use crate::{ImageBuffer, ImageFormat};
use crate::{actions::capability, refs::RefEntry};
use std::sync::Mutex;

pub(super) const MINI_PNG: &[u8] = &[
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
    0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
    0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
    0x42, 0x60, 0x82,
];

pub(super) fn entry(pid: u32) -> RefEntry {
    let bounds = crate::Rect {
        x: 1.0,
        y: 1.0,
        width: 20.0,
        height: 20.0,
    };
    RefEntry {
        process: crate::RefProcess {
            pid: crate::ProcessId::new(pid),
            process_instance: Some("test-instance".into()),
        },
        identity: crate::RefEntryIdentity {
            retained_object: None,
            role: "button".into(),
            name: Some("Run".into()),
            value: None,
            description: None,
            native_id: None,
        },
        geometry: crate::RefGeometry {
            bounds_space: None,
            bounds: Some(bounds),
            bounds_hash: bounds.bounds_hash(),
        },
        capabilities: crate::RefCapabilities {
            states: vec![],
            available_actions: vec![capability::CLICK.into()],
        },
        source: crate::RefSource {
            source_app: Some("FixtureApp".into()),
            source_window_id: Some(format!("w-{pid}")),
            source_window_title: Some("Fixture".into()),
            source_window_bounds_hash: None,
            source_surface: crate::adapter::SnapshotSurface::Window,
        },
        scope: crate::RefScope {
            root_ref: None,
            path_is_absolute: false,
            path: smallvec::SmallVec::new(),
        },
    }
}

pub(super) fn artifacts_session() -> crate::session::SessionManifest {
    start_session(StartSessionOptions {
        trace: SessionTraceMode::On,
        artifacts: ArtifactsMode::Full,
        ..Default::default()
    })
    .unwrap()
}

pub(super) struct PngAdapter {
    target: Mutex<Option<ScreenshotTarget>>,
    minimum_budget_ms: u64,
}

impl ObservationOps for PngAdapter {
    fn resolve_element_strict(
        &self,
        _entry: &RefEntry,
        _deadline: crate::Deadline,
    ) -> Result<NativeHandle, AdapterError> {
        Ok(NativeHandle::null())
    }

    crate::adapter::complete_live_observation!("button", "Run", [capability::CLICK]);
}

impl ActionOps for PngAdapter {
    fn execute_action(
        &self,
        _handle: &NativeHandle,
        _request: ActionRequest,
        _lease: &crate::InteractionLease,
    ) -> Result<ActionResult, AdapterError> {
        Ok(ActionResult::delivered_unverified("ok"))
    }
}

impl InputOps for PngAdapter {}

impl SystemOps for PngAdapter {
    crate::adapter::guarded_interaction_lease!();

    fn screenshot(
        &self,
        target: ScreenshotTarget,
        deadline: crate::Deadline,
    ) -> Result<ImageBuffer, AdapterError> {
        *self.target.lock().unwrap() = Some(target);
        if deadline.remaining_ms() < self.minimum_budget_ms {
            return Err(deadline.timeout_error());
        }
        Ok(ImageBuffer {
            data: MINI_PNG.to_vec(),
            format: ImageFormat::Png,
            width: 1,
            height: 1,
            scale_factor: 1.0,
        })
    }
}

pub(super) fn png_adapter() -> PngAdapter {
    PngAdapter {
        target: Mutex::new(None),
        minimum_budget_ms: 0,
    }
}

pub(super) fn deadline_png_adapter(minimum_budget_ms: u64) -> PngAdapter {
    PngAdapter {
        target: Mutex::new(None),
        minimum_budget_ms,
    }
}

struct FailingScreenshotAdapter;

impl ObservationOps for FailingScreenshotAdapter {
    fn resolve_element_strict(
        &self,
        _entry: &RefEntry,
        _deadline: crate::Deadline,
    ) -> Result<NativeHandle, AdapterError> {
        Ok(NativeHandle::null())
    }

    crate::adapter::complete_live_observation!("button", "Run", [capability::CLICK]);
}

impl ActionOps for FailingScreenshotAdapter {
    fn execute_action(
        &self,
        _handle: &NativeHandle,
        _request: ActionRequest,
        _lease: &crate::InteractionLease,
    ) -> Result<ActionResult, AdapterError> {
        Ok(ActionResult::delivered_unverified("ok"))
    }
}

impl InputOps for FailingScreenshotAdapter {}

impl SystemOps for FailingScreenshotAdapter {
    crate::adapter::guarded_interaction_lease!();

    fn screenshot(
        &self,
        _target: ScreenshotTarget,
        _deadline: crate::Deadline,
    ) -> Result<ImageBuffer, AdapterError> {
        Err(AdapterError::not_supported("screenshot"))
    }
}

pub(super) fn run_ref_action(
    context: &CommandContext,
    adapter: &dyn PlatformAdapter,
    pid: u32,
) -> Result<ActionResult, crate::AppError> {
    let entry = entry(pid);
    let deadline = crate::Deadline::standard()?;
    let lease = adapter.acquire_interaction_lease(deadline)?;
    let handle = NativeHandle::null();
    let target = crate::ref_action::ref_action_context::RefActionContext::new(
        crate::ref_action::ref_action_wait_context::RefActionWaitContext {
            adapter,
            entry: &entry,
            ref_id: "@e1",
            context,
        },
        deadline,
    );
    execute_resolved(
        ResolvedRefAction::new(target, &handle),
        ActionRequest::headless(Action::Click),
        &lease,
    )
}

static ARTIFACT_TEST_LOCK: Mutex<()> = Mutex::new(());

pub(super) fn setup_artifacts_test() -> (HomeGuard, std::sync::MutexGuard<'static, ()>) {
    clear_test_budgets();
    (
        HomeGuard::new(),
        ARTIFACT_TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner()),
    )
}

#[test]
fn events_mode_produces_no_artifact_files() {
    let (_home, _lock) = setup_artifacts_test();
    let manifest = start_session(StartSessionOptions {
        trace: SessionTraceMode::On,
        ..Default::default()
    })
    .unwrap();
    let context = CommandContext::new(Some(manifest.id.clone()), None, false).unwrap();
    run_ref_action(&context, &png_adapter(), 1).unwrap();
    let trace_dir = RefStore::for_session(Some(&manifest.id))
        .unwrap()
        .trace_dir();
    assert!(!trace_dir.join("screens").exists());
}

#[test]
fn trace_off_with_artifacts_full_captures_nothing() {
    let (_home, _lock) = setup_artifacts_test();
    let path = std::env::temp_dir().join(format!(
        "agent-desktop-artifacts-off-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let context = CommandContext::new(None, Some(path.clone()), true).unwrap();
    run_ref_action(&context, &png_adapter(), 1).unwrap();
    let body = std::fs::read_to_string(&path).unwrap();
    assert!(body.contains("\"event\":\"action.dispatch.ok\""));
    assert!(!body.contains("action.artifacts"));
    let _ = std::fs::remove_file(path);
}

#[test]
fn adapter_screenshot_error_still_succeeds_with_skip_reason() {
    let (_home, _lock) = setup_artifacts_test();
    let manifest = artifacts_session();
    let context = CommandContext::new(Some(manifest.id.clone()), None, false).unwrap();
    run_ref_action(&context, &FailingScreenshotAdapter, 1).unwrap();
    let trace_dir = RefStore::for_session(Some(&manifest.id))
        .unwrap()
        .trace_dir();
    let segment = std::fs::read_dir(&trace_dir)
        .unwrap()
        .find_map(|e| {
            let p = e.ok()?.path();
            p.extension().is_some_and(|ext| ext == "jsonl").then_some(p)
        })
        .unwrap();
    let body = std::fs::read_to_string(segment).unwrap();
    assert!(body.contains("adapter:"));
    clear_test_budgets();
}

#[test]
fn count_budget_exhaustion_skips_with_count_budget_reason() {
    let (_home, _lock) = setup_artifacts_test();
    set_test_budgets(128 * 1024 * 1024, 1, 64 * 1024 * 1024);
    let manifest = artifacts_session();
    let context = CommandContext::new(Some(manifest.id.clone()), None, false).unwrap();
    let adapter = png_adapter();
    run_ref_action(&context, &adapter, 1).unwrap();
    run_ref_action(&context, &adapter, 1).unwrap();
    let trace_dir = RefStore::for_session(Some(&manifest.id))
        .unwrap()
        .trace_dir();
    let count = std::fs::read_dir(trace_dir.join("screens"))
        .map(|d| d.count())
        .unwrap_or(0);
    assert_eq!(count, 1);
    let segment = std::fs::read_dir(&trace_dir)
        .unwrap()
        .find_map(|e| {
            let p = e.ok()?.path();
            p.extension().is_some_and(|ext| ext == "jsonl").then_some(p)
        })
        .unwrap();
    let body = std::fs::read_to_string(segment).unwrap();
    assert!(body.contains("\"skipped\":\"count_budget\""));
    clear_test_budgets();
}

#[cfg(unix)]
#[test]
fn symlinked_screens_dir_refuses_capture() {
    let (_home, _lock) = setup_artifacts_test();
    let manifest = artifacts_session();
    let trace_dir = RefStore::for_session(Some(&manifest.id))
        .unwrap()
        .trace_dir();
    std::fs::create_dir_all(&trace_dir).unwrap();
    let outside = trace_dir.join("outside-screens");
    std::fs::create_dir_all(&outside).unwrap();
    std::os::unix::fs::symlink(&outside, trace_dir.join("screens")).unwrap();
    let context = CommandContext::new(Some(manifest.id.clone()), None, false).unwrap();
    run_ref_action(&context, &png_adapter(), 1).unwrap();
    assert_eq!(
        std::fs::read_dir(outside).map(|d| d.count()).unwrap_or(0),
        0
    );
}

#[path = "trace_artifacts_outcome_tests.rs"]
mod outcome_tests;
