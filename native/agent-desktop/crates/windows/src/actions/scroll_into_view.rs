//! `ScrollItemPattern.ScrollIntoView` with delivery judged by observation.
//!
//! When the gate is unavailable or invoke leaves geometry unchanged, a
//! scrollable ancestor runs the ladder (A19-7); without one the unsupported /
//! not-delivered arms stay unchanged. Provider rects are unclipped (A18-2), so
//! verified visibility needs viewport intersection. Invoke failures keep tagged
//! `UiaFailure`; completed observation disposition outranks the classifier
//! (A18).

use agent_desktop_core::{
    AdapterError, Deadline, DeliverySemantics, ErrorCode, InteractionLease, Rect,
};

use crate::actions::chain::DeliveryOutcome;

#[cfg(target_os = "windows")]
mod imp {
    use super::{
        AdapterError, Deadline, DeliveryOutcome, DeliverySemantics, ErrorCode, InteractionLease,
        Rect,
    };
    use crate::actions::chain::after_delivery;
    use crate::actions::mutation::classify_mutation;
    use crate::actions::scroll::known_bounds;
    use crate::actions::scroll_ladder::{
        LADDER_SCROLL_LABEL, VisibilitySample, ancestor_ladder, apply_ladder_seam,
        observe_visibility, visibility_verified,
    };
    use crate::tree::automation::{ERR_NONE, UiaFailure, automation_client, failure_of};
    use crate::tree::element::{UIAElement, uia_element};
    use crate::tree::live_read::corroborate_verified_process;
    use crate::tree::properties::property_ids::TreeProperty;
    use crate::tree::properties::{read_one, rect_has_area};
    use crate::tree::walk::walker_source::{nearest_scroll_viewport, viewport_bounds};
    use agent_desktop_core::adapter::native_handle::NativeHandle;
    use std::time::{Duration, Instant};
    use uiautomation::core::UITreeWalker;
    use uiautomation::patterns::UIScrollItemPattern;

    const VERIFY_WINDOW: Duration = Duration::from_millis(800);
    const POLL_SLICE: Duration = Duration::from_millis(20);
    pub(crate) const SCROLL_INTO_VIEW_API: &str = "ScrollItemPattern.ScrollIntoView";
    const SCROLL_INTO_VIEW_OP: &str = "ScrollIntoView";

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub(crate) enum InvokeOutcome {
        Succeeded,
        Failed(UiaFailure),
        EmptyPattern,
    }

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub(crate) struct ScrollIntoViewDone {
        pub(crate) label: &'static str,
        pub(crate) outcome: DeliveryOutcome,
    }

    pub fn scroll_into_view_impl(
        handle: &NativeHandle,
        lease: &InteractionLease,
    ) -> Result<(), AdapterError> {
        scroll_into_view_outcome(handle, lease).map(|_| ())
    }

    pub(crate) fn scroll_into_view_outcome(
        handle: &NativeHandle,
        lease: &InteractionLease,
    ) -> Result<ScrollIntoViewDone, AdapterError> {
        let element = uia_element(handle)?;
        let deadline = lease.deadline();
        deadline.ensure_remaining()?;
        corroborate_verified_process(element)?;
        scroll_into_view_element(element, deadline)
    }

    fn scroll_into_view_element(
        element: &UIAElement,
        deadline: Deadline,
    ) -> Result<ScrollIntoViewDone, AdapterError> {
        if !scroll_item_available(element) {
            return ladder_from_terminal(unsupported_error(), element, deadline);
        }
        let client = automation_client()?;
        let walker = client.get_raw_view_walker().ok();
        let before = known_bounds(element);
        let viewport = resolve_scroll_viewport(element, walker.as_ref(), deadline);
        let invoke_failure = match invoke_scroll_into_view(element) {
            InvokeOutcome::EmptyPattern => {
                return ladder_from_terminal(unsupported_error(), element, deadline);
            }
            InvokeOutcome::Failed(failure) => Some(failure),
            InvokeOutcome::Succeeded => None,
        };
        match scroll_into_view_judged_for(deadline, before, invoke_failure, VERIFY_WINDOW, || {
            observe_visibility(
                element,
                viewport
                    .as_ref()
                    .map(viewport_bounds)
                    .transpose()?
                    .flatten(),
                deadline,
                "after ScrollIntoView",
            )
        }) {
            Ok(()) => Ok(ScrollIntoViewDone {
                label: SCROLL_INTO_VIEW_API,
                outcome: DeliveryOutcome::DeliveredVerified,
            }),
            Err(error) if error.disposition == DeliverySemantics::not_delivered() => {
                ladder_from_terminal(error, element, deadline)
            }
            Err(error) => Err(error),
        }
    }

    fn ladder_from_terminal(
        fallback: AdapterError,
        element: &UIAElement,
        deadline: Deadline,
    ) -> Result<ScrollIntoViewDone, AdapterError> {
        apply_ladder_seam(fallback, ancestor_ladder(element, deadline)).map(|outcome| {
            ScrollIntoViewDone {
                label: LADDER_SCROLL_LABEL,
                outcome,
            }
        })
    }

    /// Climb once per operation; a truncated climb leaves the viewport unresolved.
    fn resolve_scroll_viewport(
        element: &UIAElement,
        walker: Option<&UITreeWalker>,
        deadline: Deadline,
    ) -> Option<UIAElement> {
        walker.and_then(|walker| {
            nearest_scroll_viewport(element, walker, deadline)
                .ok()
                .flatten()
        })
    }

    pub(crate) fn scroll_into_view_judged_for(
        deadline: Deadline,
        before: Option<Rect>,
        invoke_failure: Option<UiaFailure>,
        verify_window: Duration,
        mut observe: impl FnMut() -> Result<VisibilitySample, AdapterError>,
    ) -> Result<(), AdapterError> {
        let local_end = Instant::now() + verify_window;
        let mut last_bounds: Option<Rect>;
        loop {
            match observe() {
                Ok(sample) => {
                    last_bounds = sample.bounds;
                    if visibility_verified(&sample) {
                        return Ok(());
                    }
                }
                Err(error) => return Err(after_delivery(error)),
            }
            if deadline.is_expired() {
                return Err(after_delivery(deadline.timeout_error().with_details(
                    serde_json::json!({
                        "verification": "scroll_visibility_not_observed",
                    }),
                )));
            }
            if Instant::now() >= local_end {
                return finish_observation(before, last_bounds, invoke_failure);
            }
            let pause = deadline
                .remaining_slice(POLL_SLICE)
                .map_err(after_delivery)?;
            std::thread::sleep(pause.min(POLL_SLICE));
        }
    }

    pub(crate) fn finish_observation(
        before: Option<Rect>,
        after: Option<Rect>,
        invoke_failure: Option<UiaFailure>,
    ) -> Result<(), AdapterError> {
        let Some(after) = completed_bounds(after) else {
            return Err(unverified_error(
                "ScrollIntoView completed without an observable after-state",
                invoke_failure,
            ));
        };
        let Some(before) = completed_bounds(before) else {
            return Err(unverified_error(
                "ScrollIntoView completed without a comparable before-state",
                invoke_failure,
            ));
        };
        if !scroll_effect_observed(before, after) {
            return Err(not_delivered_error(invoke_failure));
        }
        Err(unverified_error(
            "ScrollIntoView moved the target but visibility was not verified",
            invoke_failure,
        ))
    }

    pub(crate) fn scroll_effect_observed(before: Rect, after: Rect) -> bool {
        before.bounds_hash() != after.bounds_hash()
    }

    pub(crate) fn unsupported_error() -> AdapterError {
        AdapterError::new(
            ErrorCode::ActionFailed,
            "ScrollIntoView is not available on this element",
        )
        .with_suggestion(
            "The element does not expose ScrollItemPattern; scroll a containing viewport first, or target a scroll-item control",
        )
        .with_details(serde_json::json!({
            "kind": "scroll_into_view_unsupported",
            "complete": true,
            "retryable": false,
        }))
        .with_disposition(DeliverySemantics::not_delivered())
    }

    fn not_delivered_error(invoke_failure: Option<UiaFailure>) -> AdapterError {
        overlay_invoke_classification(
            AdapterError::new(
                ErrorCode::ActionFailed,
                "ScrollIntoView did not change target geometry",
            )
            .with_disposition(DeliverySemantics::not_delivered()),
            invoke_failure,
        )
    }

    fn unverified_error(message: &str, invoke_failure: Option<UiaFailure>) -> AdapterError {
        overlay_invoke_classification(
            AdapterError::new(ErrorCode::ActionFailed, message)
                .with_disposition(DeliverySemantics::delivered_unverified()),
            invoke_failure,
        )
    }

    /// Observation disposition stands over transport-uncertain invoke HRESULTs (A18).
    fn overlay_invoke_classification(
        observation: AdapterError,
        invoke_failure: Option<UiaFailure>,
    ) -> AdapterError {
        let Some(failure) = invoke_failure else {
            return observation;
        };
        match classify_mutation(SCROLL_INTO_VIEW_OP, SCROLL_INTO_VIEW_API, &failure) {
            Ok(_) => observation,
            Err(classified) => {
                let mut error = AdapterError::new(classified.code, classified.message)
                    .with_disposition(observation.disposition);
                if let Some(detail) = classified.platform_detail {
                    error = error.with_platform_detail(detail);
                }
                if let Some(suggestion) = classified.suggestion {
                    error = error.with_suggestion(suggestion);
                }
                if let Some(details) = observation.details {
                    error = error.with_details(details);
                }
                error
            }
        }
    }

    fn completed_bounds(bounds: Option<Rect>) -> Option<Rect> {
        bounds.filter(rect_has_area)
    }

    fn scroll_item_available(element: &UIAElement) -> bool {
        read_one(element, TreeProperty::ScrollItemAvailable).flag() == Some(true)
    }

    fn invoke_scroll_into_view(element: &UIAElement) -> InvokeOutcome {
        match element.0.get_pattern::<UIScrollItemPattern>() {
            Ok(pattern) => match pattern.scroll_into_view() {
                Ok(()) => InvokeOutcome::Succeeded,
                Err(error) => match failure_of(&error) {
                    UiaFailure::Sentinel(ERR_NONE) => InvokeOutcome::EmptyPattern,
                    failure => InvokeOutcome::Failed(failure),
                },
            },
            Err(error) => match failure_of(&error) {
                UiaFailure::Sentinel(ERR_NONE) => InvokeOutcome::EmptyPattern,
                other if other.is_exhaustion() => InvokeOutcome::EmptyPattern,
                failure => InvokeOutcome::Failed(failure),
            },
        }
    }
}

#[cfg(not(target_os = "windows"))]
mod imp {
    use super::{AdapterError, DeliveryOutcome, InteractionLease};
    use agent_desktop_core::adapter::native_handle::NativeHandle;

    pub(crate) struct ScrollIntoViewDone {
        pub(crate) label: &'static str,
        pub(crate) outcome: DeliveryOutcome,
    }

    pub fn scroll_into_view_impl(
        _handle: &NativeHandle,
        _lease: &InteractionLease,
    ) -> Result<(), AdapterError> {
        Err(AdapterError::not_supported("scroll_into_view"))
    }

    pub(crate) fn scroll_into_view_outcome(
        _handle: &NativeHandle,
        _lease: &InteractionLease,
    ) -> Result<ScrollIntoViewDone, AdapterError> {
        Err(AdapterError::not_supported("scroll_into_view"))
    }
}

pub(crate) use imp::{scroll_into_view_impl, scroll_into_view_outcome};

#[cfg(all(test, target_os = "windows"))]
pub(crate) use crate::actions::scroll_ladder::{VisibilitySample, visibility_verified};

#[cfg(all(test, target_os = "windows"))]
pub(crate) use imp::{
    finish_observation, scroll_effect_observed, scroll_into_view_judged_for, unsupported_error,
};

#[cfg(all(test, target_os = "windows"))]
#[path = "scroll_into_view_tests.rs"]
mod tests;
