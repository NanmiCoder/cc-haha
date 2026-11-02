//! Windows `ElementFromPoint` hit testing for the actionability occlusion gate.
//!
//! Coordinate space is shared by construction (A18-9): `ElementFromPoint` and
//! `BoundingRectangle` both speak physical screen pixels under the process
//! `PER_MONITOR_AWARE_V2` bootstrap; the only transform is a saturating
//! `f64`→`i32` narrowing into the crate `Point`. Mixed-DPI live verification
//! stays with the A16-4 deferral chain.
//!
//! Ancestor landings yield `Unknown` with no macOS-style application-scoped
//! retry — UIA has no scoped `ElementFromPoint`. That is the designed Chromium
//! outcome when a render-host pane answers for non-hit-addressable web content.
//!
//! Unrelated hits reach window-attribution corroboration (`hit_test_corroborate`):
//! `InterceptedBy` only on two-opinion agreement. The demotion for points
//! outside `target ∩ scroll viewport` (A18-2 unclipped provider rects) answers
//! a same-window question — an unclipped rect puts candidate points over
//! neighbours sharing the target's root — so it is applied to the same-root arm
//! inside that seam and never silences a corroborated cross-window occluder.
//!
//! Everything after the probe walks ancestors across process boundaries, so
//! each walk step consults the operation deadline and a truncated walk answers
//! `Unknown` rather than deciding on partial evidence.

use agent_desktop_core::{
    AdapterError, Deadline, ErrorCode, Point, Rect, adapter::hit_test::HitTestResult,
    adapter::native_handle::NativeHandle,
};

#[cfg(target_os = "windows")]
#[path = "hit_test_classify.rs"]
mod classify;
#[cfg(target_os = "windows")]
pub(crate) use classify::intersect_rects;

#[cfg(target_os = "windows")]
#[path = "hit_test_corroborate.rs"]
pub(crate) mod corroborate;

#[cfg(target_os = "windows")]
mod imp {
    use super::classify;
    use super::corroborate;
    use super::{AdapterError, Deadline, ErrorCode, HitTestResult, NativeHandle, Point, Rect};
    use crate::system::runtime::hresult::ReadDisposition;
    use crate::tree::automation::{
        UiaFailure, automation_client, failure_of, uia_failure_disposition, uia_failure_error,
    };
    use crate::tree::element::{UIAElement, uia_element};
    use crate::tree::live_read::corroborate_verified_process;
    use crate::tree::properties::rect_from_uia;
    use crate::tree::walk::walker_source;
    use uiautomation::UIAutomation;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetSystemMetrics, IsIconic, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN,
        SM_YVIRTUALSCREEN,
    };

    /// Hit-tests `point` via bounded `ElementFromPoint`, then classifies the
    /// frontmost result against `target`. Every probe failure, guard trip, and
    /// ancestor landing is `Unknown`; `Err` is reserved for invalid handles,
    /// crossed deadlines, and the target pre-read's dead-token / permission /
    /// transport-retryable escapes.
    pub fn hit_test_impl(
        handle: &NativeHandle,
        point: Point,
        deadline: Deadline,
    ) -> Result<HitTestResult, AdapterError> {
        let target = uia_element(handle)?;
        deadline.ensure_remaining()?;
        let client = automation_client()?;
        hit_test_element(target, point, deadline, &client)
    }

    fn hit_test_element(
        target: &UIAElement,
        point: Point,
        deadline: Deadline,
        client: &UIAutomation,
    ) -> Result<HitTestResult, AdapterError> {
        corroborate_verified_process(target)?;
        let bounds = match read_target_bounds(target)? {
            Some(bounds) => bounds,
            None => return Ok(HitTestResult::Unknown),
        };
        corroborate_verified_process(target)?;
        let Ok(walker) = client.get_raw_view_walker() else {
            return Ok(HitTestResult::Unknown);
        };
        let Ok(target_root) = corroborate::element_root_hwnd(target, &walker, deadline) else {
            return Ok(classify::result_for_incomplete_walk());
        };
        if let Some(unknown) = pre_probe_guard(&bounds, &point, target_root) {
            return Ok(unknown);
        }
        deadline.ensure_remaining()?;
        judge_probe(probe_element_from_point(client, &point), |hit| {
            let context = corroborate::InterceptionContext {
                target,
                target_root,
                hit: &hit,
                point,
                walker: &walker,
                deadline,
            };
            judge_hit(&context, &bounds, client)
        })
    }

    fn judge_hit(
        context: &corroborate::InterceptionContext<'_>,
        bounds: &Rect,
        client: &UIAutomation,
    ) -> HitTestResult {
        let same = |left: &UIAElement, right: &UIAElement| {
            walker_source::same_element(client, left, right)
        };
        let identity = |node: &UIAElement| walker_source::identity(node);
        let parent_of = |node: &UIAElement| walker_source::parent_step(context.walker, node);
        let walk = classify::AncestryWalk {
            same_element: &same,
            identity: &identity,
            parent_of: &parent_of,
            deadline: context.deadline,
        };
        let Some(classification) = classify::classify_hit_with(context.target, context.hit, &walk)
        else {
            return classify::result_for_incomplete_walk();
        };
        resolve_classification(classification, || {
            corroborate_with_viewport(context, bounds)
        })
    }

    /// The viewport climb is corroboration's input and nobody else's: it asks
    /// whether an unrelated hit is a same-window artefact of an unclipped
    /// provider rect (A18-2). Resolving it here rather than ahead of the
    /// classification keeps a determined verdict out of its reach - a climb the
    /// budget truncates answers `Unknown` for the arm that asked and for no
    /// other - and spares every reaching hit an ancestor climb of up to
    /// `DEFAULT_MAX_RAW_DEPTH` cross-process steps whose answer it would discard.
    fn corroborate_with_viewport(
        context: &corroborate::InterceptionContext<'_>,
        bounds: &Rect,
    ) -> HitTestResult {
        let viewport = match walker_source::nearest_scroll_viewport_bounds(
            context.target,
            context.walker,
            context.deadline,
        ) {
            Ok(viewport) => viewport,
            Err(walker_source::BudgetExpired) => return classify::result_for_incomplete_walk(),
        };
        let demote =
            classify::should_demote_outside_viewport(&context.point, bounds, viewport.as_ref());
        corroborate::corroborate_interception(context, demote)
    }

    pub(super) fn resolve_classification(
        classification: classify::HitClassification,
        corroborate: impl FnOnce() -> HitTestResult,
    ) -> HitTestResult {
        match classification {
            classify::HitClassification::ReachesTarget => HitTestResult::ReachesTarget,
            classify::HitClassification::AncestorOfTarget => HitTestResult::Unknown,
            classify::HitClassification::Unrelated => corroborate(),
        }
    }

    fn read_target_bounds(target: &UIAElement) -> Result<Option<Rect>, AdapterError> {
        match target.0.get_bounding_rectangle() {
            Ok(rectangle) => Ok(Some(rect_from_uia(rectangle))),
            Err(error) => match pre_read_fate(failure_of(&error)) {
                PreReadFate::Unknown => Ok(None),
                PreReadFate::Escape(error) => Err(error),
            },
        }
    }

    #[derive(Debug)]
    enum PreReadFate {
        Unknown,
        Escape(AdapterError),
    }

    fn pre_read_fate(failure: UiaFailure) -> PreReadFate {
        let error = uia_failure_error(failure, "read hit-test target bounds");
        match uia_failure_disposition(failure) {
            ReadDisposition::SettledAbsence => PreReadFate::Unknown,
            ReadDisposition::Retryable | ReadDisposition::Unavailable => PreReadFate::Escape(error),
            ReadDisposition::Terminal if error.code == ErrorCode::PermDenied => {
                PreReadFate::Escape(error)
            }
            ReadDisposition::Terminal => PreReadFate::Unknown,
        }
    }

    fn pre_probe_guard(
        bounds: &Rect,
        point: &Point,
        target_root: Option<isize>,
    ) -> Option<HitTestResult> {
        classify::pre_probe_decision(
            bounds,
            point,
            &virtual_screen_rect(),
            root_is_iconic(target_root),
        )
        .map(classify::result_for_guard)
    }

    /// Judges a probe hit, or collapses a probe miss to `Unknown` so a flaky
    /// ElementFromPoint cannot abort the battery as `Err` (core propagates
    /// non-PlatformNotSupported). A miss never reaches `judge`.
    pub(super) fn judge_probe<T>(
        probe: Option<T>,
        judge: impl FnOnce(T) -> HitTestResult,
    ) -> Result<HitTestResult, AdapterError> {
        match probe {
            Some(hit) => Ok(judge(hit)),
            None => Ok(HitTestResult::Unknown),
        }
    }

    fn probe_element_from_point(client: &UIAutomation, point: &Point) -> Option<UIAElement> {
        let physical = physical_point(point);
        client
            .element_from_point(physical)
            .ok()
            .map(UIAElement::from)
    }

    pub(super) fn physical_point(point: &Point) -> uiautomation::types::Point {
        uiautomation::types::Point::new(saturate_coord(point.x), saturate_coord(point.y))
    }

    pub(super) fn saturate_coord(value: f64) -> i32 {
        if !value.is_finite() {
            return 0;
        }
        if value >= f64::from(i32::MAX) {
            i32::MAX
        } else if value <= f64::from(i32::MIN) {
            i32::MIN
        } else {
            value as i32
        }
    }

    /// The virtual screen's origin and extent, in the physical pixels every
    /// other coordinate here already speaks.
    ///
    /// The raw tuple is the shared primitive: a caller that only needs to park
    /// a window inside the desktop wants the four metrics, not a `Rect` it
    /// would immediately narrow back to `i32`.
    pub(crate) fn virtual_screen_metrics() -> (i32, i32, i32, i32) {
        unsafe {
            (
                GetSystemMetrics(SM_XVIRTUALSCREEN),
                GetSystemMetrics(SM_YVIRTUALSCREEN),
                GetSystemMetrics(SM_CXVIRTUALSCREEN),
                GetSystemMetrics(SM_CYVIRTUALSCREEN),
            )
        }
    }

    fn virtual_screen_rect() -> Rect {
        let (left, top, width, height) = virtual_screen_metrics();
        Rect {
            x: f64::from(left),
            y: f64::from(top),
            width: f64::from(width.max(0)),
            height: f64::from(height.max(0)),
        }
    }

    /// An unresolved root reads as minimized: the window question went
    /// unanswered, and an unanswered question never authorizes a probe.
    fn root_is_iconic(target_root: Option<isize>) -> bool {
        match target_root {
            Some(root) => unsafe { IsIconic(root as *mut std::ffi::c_void) != 0 },
            None => true,
        }
    }

    #[cfg(test)]
    pub(super) fn pre_read_fate_for_test(failure: UiaFailure) -> Result<(), AdapterError> {
        match pre_read_fate(failure) {
            PreReadFate::Unknown => Ok(()),
            PreReadFate::Escape(error) => Err(error),
        }
    }
}

#[cfg(not(target_os = "windows"))]
mod imp {
    use super::{AdapterError, Deadline, HitTestResult, NativeHandle, Point};

    pub fn hit_test_impl(
        _handle: &NativeHandle,
        _point: Point,
        _deadline: Deadline,
    ) -> Result<HitTestResult, AdapterError> {
        Err(AdapterError::not_supported("hit_test"))
    }
}

pub(crate) use imp::hit_test_impl;

#[cfg(target_os = "windows")]
pub(crate) use imp::virtual_screen_metrics;

#[cfg(all(test, target_os = "windows"))]
#[path = "hit_test_tests.rs"]
mod tests;

#[cfg(all(test, target_os = "windows"))]
#[path = "hit_test_guard_tests.rs"]
mod guard_tests;

#[cfg(all(test, target_os = "windows"))]
#[path = "hit_test_live_tests.rs"]
mod live_tests;

#[cfg(all(test, target_os = "windows"))]
#[path = "envelope_tests.rs"]
mod envelope_tests;

#[cfg(all(test, target_os = "windows"))]
#[path = "envelope_live_tests.rs"]
mod envelope_live_tests;
