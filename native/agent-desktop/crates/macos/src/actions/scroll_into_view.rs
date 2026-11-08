#[cfg(target_os = "macos")]
mod imp {
    use crate::actions::chain::chain_delivery::DeliveryOutcome;
    use crate::tree::AXElement;
    use agent_desktop_core::{
        AdapterError, Deadline, DeliverySemantics, Direction, ErrorCode, InteractionPolicy, Rect,
    };
    use std::time::{Duration, Instant};

    const MAX_ANCESTOR_SCROLLS: usize = 10;

    pub fn scroll_into_view_impl(
        element: &AXElement,
        deadline: Deadline,
    ) -> Result<(), AdapterError> {
        scroll_into_view_outcome(element, deadline).map(|_| ())
    }

    pub(crate) fn scroll_into_view_outcome(
        element: &AXElement,
        deadline: Deadline,
    ) -> Result<DeliveryOutcome, AdapterError> {
        match scroll_to_verified(element, deadline)? {
            outcome @ (DeliveryOutcome::SatisfiedNoDelivery
            | DeliveryOutcome::DeliveredVerified) => Ok(outcome),
            DeliveryOutcome::NotDelivered | DeliveryOutcome::DeliveredWithoutEffect => {
                scroll_ancestor_until_visible(element, deadline)
            }
            DeliveryOutcome::DeliveredUnverified => Err(unverified_scroll_error()),
        }
    }

    fn scroll_ancestor_until_visible(
        element: &AXElement,
        deadline: Deadline,
    ) -> Result<DeliveryOutcome, AdapterError> {
        let mut delivery = crate::actions::DeliveryTracker::default();
        for attempt in 0..MAX_ANCESTOR_SCROLLS {
            let Some(direction) = direction_to_viewport(element, deadline)
                .map_err(|error| delivery.annotate(error))?
            else {
                if !visible_through_ancestors(element, deadline)
                    .map_err(|error| delivery.annotate(error))?
                {
                    return Err(delivery.annotate(AdapterError::new(
                        ErrorCode::ActionFailed,
                        "Target remains clipped or its visible bounds are unknown",
                    )));
                }
                return Ok(if attempt == 0 {
                    DeliveryOutcome::SatisfiedNoDelivery
                } else {
                    DeliveryOutcome::DeliveredVerified
                });
            };
            let parent = crate::actions::scroll_read::element(element, "AXParent", deadline)
                .map_err(|error| delivery.annotate(error))?
                .ok_or_else(|| {
                    delivery.annotate(AdapterError::new(
                        ErrorCode::ActionNotSupported,
                        "Target has no ancestor to scroll",
                    ))
                })?;
            crate::actions::scroll::ax_scroll(
                &parent,
                &direction,
                1,
                InteractionPolicy::headless(),
                deadline,
            )
            .map_err(|error| delivery.annotate(error))?;
            delivery.mark_delivered();
        }
        Err(AdapterError::new(
            ErrorCode::ActionFailed,
            "Semantic ancestor scrolling did not bring the target into view",
        )
        .with_disposition(DeliverySemantics::delivered_unverified()))
    }

    fn direction_to_viewport(
        element: &AXElement,
        deadline: Deadline,
    ) -> Result<Option<Direction>, AdapterError> {
        let instant = crate::tree::locator_deadline::from_operation(deadline)?;
        let bounds = crate::tree::element_bounds::read_bounds_with_deadline(element, instant)?
            .ok_or_else(|| AdapterError::new(ErrorCode::ActionFailed, "Target has no bounds"))?;
        let found = crate::actions::scroll::find_scroll_area(element, deadline)?;
        let found_is_target = found
            .as_ref()
            .is_some_and(|area| crate::tree::same_element(area, element));
        let scroll_area = match viewport_seed(found_is_target) {
            ViewportSeed::Target => found,
            ViewportSeed::Parent => enclosing_scroll_area(element, deadline)?,
        };
        let viewport = match scroll_area {
            Some(viewport) => viewport,
            None => require_window(crate::tree::surface_read::element(
                element, "AXWindow", instant,
            )?)?,
        };
        let viewport_bounds =
            crate::tree::element_bounds::read_bounds_with_deadline(&viewport, instant)?
                .ok_or_else(|| {
                    AdapterError::new(ErrorCode::ActionFailed, "Target viewport has no bounds")
                })?;
        Ok(direction_for_visibility(bounds, viewport_bounds))
    }

    pub(super) enum ViewportSeed {
        Target,
        Parent,
    }

    /// Revealing a target scrolls the scroll area that encloses it, which is
    /// always a strict ancestor: a scroll-area target seeded as its own search
    /// root is compared against its own bounds and can never yield a scroll
    /// direction. The element-seeded `find_scroll_area` walk runs exactly as
    /// before; only when it returns the target itself is the search repeated
    /// from the target's parent.
    pub(super) fn viewport_seed(found_is_target: bool) -> ViewportSeed {
        if found_is_target {
            ViewportSeed::Parent
        } else {
            ViewportSeed::Target
        }
    }

    fn enclosing_scroll_area(
        element: &AXElement,
        deadline: Deadline,
    ) -> Result<Option<AXElement>, AdapterError> {
        match crate::actions::scroll_read::element(element, "AXParent", deadline)? {
            Some(parent) => crate::actions::scroll::find_scroll_area(&parent, deadline),
            None => Ok(None),
        }
    }

    pub(super) fn require_window(window: Option<AXElement>) -> Result<AXElement, AdapterError> {
        window.ok_or_else(|| {
            AdapterError::new(
                ErrorCode::ActionFailed,
                "Target window is unavailable; visibility cannot be verified",
            )
        })
    }

    pub(crate) fn direction_for_visibility(target: Rect, viewport: Rect) -> Option<Direction> {
        if target.y < viewport.y {
            Some(Direction::Up)
        } else if target.y + target.height > viewport.y + viewport.height {
            Some(Direction::Down)
        } else if target.x < viewport.x {
            Some(Direction::Left)
        } else if target.x + target.width > viewport.x + viewport.width {
            Some(Direction::Right)
        } else {
            None
        }
    }

    pub(crate) fn scroll_to_verified(
        element: &AXElement,
        deadline: Deadline,
    ) -> Result<DeliveryOutcome, AdapterError> {
        prepare(element, deadline)?;
        let before = element_bounds(element, deadline)?;
        if !crate::actions::ax_helpers::try_ax_action_or_err(
            element,
            "AXScrollToVisible",
            deadline,
        )? {
            return Ok(DeliveryOutcome::NotDelivered);
        }
        let local_end = Instant::now() + Duration::from_millis(800);
        loop {
            if visible_through_ancestors(element, deadline).map_err(after_delivery)? {
                return Ok(DeliveryOutcome::DeliveredVerified);
            }
            if deadline.is_expired() {
                return Err(after_delivery(deadline.timeout_error().with_details(
                    serde_json::json!({
                        "verification": "scroll_visibility_not_observed",
                    }),
                )));
            }
            if Instant::now() >= local_end {
                return settled_scroll_outcome(before, element_bounds(element, deadline));
            }
            let pause = deadline
                .remaining_slice(Duration::from_millis(20))
                .map_err(after_delivery)?;
            std::thread::sleep(pause.min(Duration::from_millis(20)));
        }
    }

    pub(super) fn settled_scroll_outcome(
        before: Option<Rect>,
        after: Result<Option<Rect>, AdapterError>,
    ) -> Result<DeliveryOutcome, AdapterError> {
        if !scroll_effect_observed(before, after.map_err(after_delivery)?) {
            return Ok(DeliveryOutcome::NotDelivered);
        }
        Err(unverified_scroll_error())
    }

    fn element_bounds(
        element: &AXElement,
        deadline: Deadline,
    ) -> Result<Option<Rect>, AdapterError> {
        crate::tree::element_bounds::read_bounds_with_deadline(
            element,
            crate::tree::locator_deadline::from_operation(deadline)?,
        )
    }

    pub(crate) fn scroll_effect_observed(before: Option<Rect>, after: Option<Rect>) -> bool {
        match (before, after) {
            (Some(before), Some(after)) => before.bounds_hash() != after.bounds_hash(),
            (None, None) => false,
            _ => true,
        }
    }

    pub(super) fn unverified_scroll_error() -> AdapterError {
        AdapterError::new(
            ErrorCode::ActionFailed,
            "AXScrollToVisible completed but target visibility was not verified",
        )
        .with_disposition(DeliverySemantics::delivered_unverified())
        .with_suggestion("Inspect target visibility before deciding whether to scroll again.")
    }

    fn visible_through_ancestors(
        element: &AXElement,
        deadline: Deadline,
    ) -> Result<bool, AdapterError> {
        if crate::actions::scroll_read::element(element, "AXWindow", deadline)?.is_none() {
            return Ok(false);
        }
        Ok(
            crate::tree::hit_test::visible_bounds_ax_element(element, deadline)?
                .is_some_and(rect_has_area),
        )
    }

    pub(crate) fn rect_has_area(rect: Rect) -> bool {
        rect.x.is_finite()
            && rect.y.is_finite()
            && rect.width.is_finite()
            && rect.height.is_finite()
            && rect.width > 0.0
            && rect.height > 0.0
    }

    fn prepare(element: &AXElement, deadline: Deadline) -> Result<(), AdapterError> {
        crate::tree::properties::attributes::set_messaging_timeout(element, deadline)
    }

    fn after_delivery(error: AdapterError) -> AdapterError {
        error.with_disposition(DeliverySemantics::delivered_unverified())
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    use crate::tree::AXElement;
    use agent_desktop_core::{AdapterError, Deadline};

    pub fn scroll_into_view_impl(
        _element: &AXElement,
        _deadline: Deadline,
    ) -> Result<(), AdapterError> {
        Err(AdapterError::not_supported("scroll_into_view"))
    }
}

pub(crate) use imp::scroll_into_view_impl;

#[cfg(target_os = "macos")]
pub(crate) use imp::scroll_into_view_outcome;

#[cfg(all(test, target_os = "macos"))]
pub(crate) use imp::{direction_for_visibility, rect_has_area, scroll_effect_observed};

#[cfg(all(test, target_os = "macos"))]
#[path = "scroll_into_view_tests.rs"]
mod tests;

#[cfg(all(test, target_os = "macos"))]
mod evidence_tests {
    #[test]
    fn missing_window_is_not_verified_visibility() {
        assert!(super::imp::require_window(None).is_err());
        assert_eq!(
            super::imp::unverified_scroll_error().disposition,
            agent_desktop_core::DeliverySemantics::delivered_unverified()
        );
    }
}
