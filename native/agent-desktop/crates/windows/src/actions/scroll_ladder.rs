//! Ancestor-scroll ladder for ScrollTo when ScrollItemPattern is absent or
//! leaves geometry unchanged (A19-7).
//!
//! Direction comes from the target's fresh bounds against the nearest
//! ScrollPattern-available ancestor viewport (macOS `direction_for_visibility`
//! parity). Visibility uses the shipped ScrollIntoView predicate — IsOffscreen
//! false, positive-area bounds, and viewport containment when the target fits — because provider
//! rects are unclipped (A18-2).

use agent_desktop_core::{AdapterError, Deadline, DeliverySemantics, Direction, ErrorCode, Rect};

use crate::actions::chain::DeliveryOutcome;
use crate::tree::element::UIAElement;

pub(crate) const MAX_ANCESTOR_SCROLLS: usize = 10;
pub(crate) const LADDER_SCROLL_LABEL: &str = "ScrollPattern";

/// Center the target without page-sized oscillation; view size is percent of content.
#[cfg(target_os = "windows")]
pub(crate) fn centered_scroll_percent(
    current: f64,
    view_percent: f64,
    viewport_extent: f64,
    offset: f64,
) -> Result<f64, AdapterError> {
    if !current.is_finite()
        || !(0.0..=100.0).contains(&current)
        || !view_percent.is_finite()
        || view_percent <= 0.0
        || view_percent >= 100.0
        || !viewport_extent.is_finite()
        || viewport_extent <= 0.0
        || !offset.is_finite()
    {
        return Err(
            AdapterError::new(ErrorCode::ActionFailed, "Invalid scroll viewport metrics")
                .with_disposition(DeliverySemantics::not_delivered()),
        );
    }
    let scrollable = viewport_extent * (100.0 - view_percent) / view_percent;
    Ok((current + offset / scrollable * 100.0).clamp(0.0, 100.0))
}

#[cfg(target_os = "windows")]
#[derive(Debug, Clone, Copy)]
pub(crate) struct VisibilitySample {
    pub(crate) bounds: Option<Rect>,
    pub(crate) offscreen: Option<bool>,
    pub(crate) viewport: Option<Rect>,
}

/// On-screen, positive area, and - when a viewport rect resolves - intersecting
/// it (A18-2).
///
/// A viewport that does not resolve means the container did not report one, not
/// that the element is hidden. Treating the two alike fails every element whose
/// container keeps its viewport to itself: the provider reports the element
/// on-screen with real bounds, the intersection test cannot run, visibility is
/// declared unverified forever, and because an already-visible element makes
/// `ScrollIntoView` a legitimate no-op, the unchanged geometry is then read as
/// a failed scroll. Reproduced against File Explorer's tree rows, which are
/// plainly on screen and returned `ACTION_FAILED` for exactly this reason.
///
/// So the viewport is a strengthening check rather than a required one. Without
/// it the provider's own `IsOffscreen` is the verdict, which is the same source
/// the offscreen guard above already trusts.
#[cfg(target_os = "windows")]
pub(crate) fn visibility_verified(sample: &VisibilitySample) -> bool {
    use crate::tree::properties::rect_has_area;

    let Some(bounds) = sample.bounds else {
        return false;
    };
    if !rect_has_area(&bounds) || sample.offscreen != Some(false) {
        return false;
    }
    match sample.viewport {
        Some(viewport) if bounds.width <= viewport.width && bounds.height <= viewport.height => {
            direction_for_visibility(bounds, viewport).is_none()
        }
        Some(viewport) => intersects(bounds, viewport),
        None => true,
    }
}

#[cfg(target_os = "windows")]
pub(crate) fn intersects(left: Rect, right: Rect) -> bool {
    left.x < right.x + right.width
        && left.x + left.width > right.x
        && left.y < right.y + right.height
        && left.y + left.height > right.y
}

/// Pure geometry → scroll direction (vertical before horizontal, before-edge
/// before after-edge).
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

/// After a visibility miss, geometry must name a direction — never invent Down.
#[cfg(target_os = "windows")]
pub(crate) fn direction_after_visibility_miss(
    sample: &VisibilitySample,
) -> Result<Direction, AdapterError> {
    let (Some(bounds), Some(viewport)) = (sample.bounds, sample.viewport) else {
        return Err(AdapterError::new(
            ErrorCode::ActionFailed,
            "Could not determine ancestor scroll direction without target and viewport bounds",
        )
        .with_disposition(DeliverySemantics::not_delivered()));
    };
    direction_for_visibility(bounds, viewport).ok_or_else(|| {
        AdapterError::new(
            ErrorCode::ActionFailed,
            "Target is not visible but geometry does not indicate a scroll direction",
        )
        .with_disposition(DeliverySemantics::not_delivered())
    })
}

/// Injected ladder — unit-test seam and live path.
///
/// `next_direction` returns `None` when the target is in view (live path folds
/// the intersection predicate into that signal so an unclipped straddler does
/// not verify — A18-2). `scroll_once` performs one semantic scroll write.
pub(crate) fn ladder_judged_for(
    deadline: Deadline,
    next_direction: &mut dyn FnMut() -> Result<Option<Direction>, AdapterError>,
    scroll_once: &mut dyn FnMut(&Direction) -> Result<(), AdapterError>,
) -> Result<DeliveryOutcome, AdapterError> {
    let mut scrolled = false;
    for attempt in 0..MAX_ANCESTOR_SCROLLS {
        deadline
            .ensure_remaining()
            .map_err(|error| budget_disposition(scrolled, error))?;
        let Some(direction) =
            next_direction().map_err(|error| budget_disposition(scrolled, error))?
        else {
            return Ok(if attempt == 0 {
                DeliveryOutcome::SatisfiedNoDelivery
            } else {
                DeliveryOutcome::DeliveredVerified
            });
        };
        scroll_once(&direction).map_err(|error| budget_disposition(scrolled, error))?;
        scrolled = true;
    }
    Err(AdapterError::new(
        ErrorCode::ActionFailed,
        "Semantic ancestor scrolling did not bring the target into view",
    )
    .with_disposition(DeliverySemantics::delivered_unverified()))
}

fn budget_disposition(scrolled: bool, error: AdapterError) -> AdapterError {
    if scrolled {
        error.with_disposition(DeliverySemantics::delivered_unverified())
    } else if matches!(
        error.disposition,
        DeliverySemantics::Unknown | DeliverySemantics::NotDelivered
    ) {
        error.with_disposition(DeliverySemantics::not_delivered())
    } else {
        error
    }
}

#[cfg(target_os = "windows")]
mod imp {
    use super::{
        AdapterError, Deadline, DeliveryOutcome, DeliverySemantics, Direction, LADDER_SCROLL_LABEL,
        UIAElement, VisibilitySample, centered_scroll_percent, ladder_judged_for,
        visibility_verified,
    };
    use crate::actions::mutation::{classify_success, classify_write};
    use crate::tree::automation::{automation_client, uia_error};
    use crate::tree::live_read::corroborate_verified_process;
    use crate::tree::properties::property_ids::TreeProperty;
    use crate::tree::properties::property_outcome::{PropertyOutcome, PropertyValue};
    use crate::tree::properties::read_one;
    use crate::tree::walk::walker_source::{nearest_scroll_viewport, viewport_bounds};
    use agent_desktop_core::{ErrorCode, LocatorField, Rect};
    use uiautomation::patterns::UIScrollPattern;

    /// Runs the ancestor ladder when a scrollable ancestor exists.
    ///
    /// `Ok(None)` means no ancestor — the caller keeps its terminal arm.
    pub(crate) fn ancestor_ladder(
        element: &UIAElement,
        deadline: Deadline,
    ) -> Result<Option<DeliveryOutcome>, AdapterError> {
        deadline.ensure_remaining()?;
        corroborate_verified_process(element)?;
        let client = automation_client()?;
        let Some(walker) = client.get_raw_view_walker().ok() else {
            return Ok(None);
        };
        match nearest_scroll_viewport(element, &walker, deadline) {
            Ok(None) => Ok(None),
            Err(crate::tree::walk::walker_source::BudgetExpired) => Err(deadline.timeout_error()),
            Ok(Some(ancestor)) => {
                scroll_ancestor_until_visible(element, &ancestor, deadline).map(Some)
            }
        }
    }

    fn scroll_ancestor_until_visible(
        element: &UIAElement,
        ancestor: &UIAElement,
        deadline: Deadline,
    ) -> Result<DeliveryOutcome, AdapterError> {
        let mut next_direction =
            || direction_when_not_visible(element, viewport_bounds(ancestor)?, deadline);
        let mut scroll_once =
            |direction: &Direction| scroll_cached_ancestor(element, ancestor, direction, deadline);
        ladder_judged_for(deadline, &mut next_direction, &mut scroll_once)
    }

    /// `None` only when the ScrollIntoView visibility predicate passes (A18-2).
    fn direction_when_not_visible(
        element: &UIAElement,
        viewport: Option<Rect>,
        deadline: Deadline,
    ) -> Result<Option<Direction>, AdapterError> {
        let sample = observe_visibility(element, viewport, deadline, "during ancestor scroll")?;
        if visibility_verified(&sample) {
            return Ok(None);
        }
        Ok(Some(super::direction_after_visibility_miss(&sample)?))
    }

    /// Shared by the ScrollIntoView spine and the ancestor ladder: `context`
    /// names the write the re-read follows, so each caller's error message
    /// stays specific to what it just attempted.
    pub(crate) fn observe_visibility(
        element: &UIAElement,
        viewport: Option<Rect>,
        deadline: Deadline,
        context: &str,
    ) -> Result<VisibilitySample, AdapterError> {
        deadline.ensure_remaining()?;
        corroborate_verified_process(element)?;
        let bounds = match read_one(element, TreeProperty::BoundingRectangle).bounds() {
            LocatorField::Known(bounds) => Some(bounds),
            LocatorField::Absent => None,
            LocatorField::Unknown => {
                return Err(AdapterError::new(
                    ErrorCode::ActionFailed,
                    format!("Could not re-read target bounds {context}"),
                ));
            }
        };
        let offscreen = match read_one(element, TreeProperty::IsOffscreen) {
            PropertyOutcome::Known(PropertyValue::Flag(flag)) => Some(flag),
            PropertyOutcome::Absent => None,
            PropertyOutcome::Unknown => {
                return Err(AdapterError::new(
                    ErrorCode::ActionFailed,
                    format!("Could not re-read IsOffscreen {context}"),
                ));
            }
            PropertyOutcome::Known(_) => None,
        };
        Ok(VisibilitySample {
            bounds,
            offscreen,
            viewport,
        })
    }

    fn scroll_cached_ancestor(
        element: &UIAElement,
        ancestor: &UIAElement,
        direction: &Direction,
        deadline: Deadline,
    ) -> Result<(), AdapterError> {
        deadline.ensure_remaining()?;
        corroborate_verified_process(ancestor)?;
        let pattern = match ancestor.0.get_pattern::<UIScrollPattern>() {
            Ok(pattern) => pattern,
            Err(error) => {
                return require_scroll_delivery(classify_write(
                    "get_pattern",
                    LADDER_SCROLL_LABEL,
                    &error,
                ));
            }
        };
        let bounds = crate::actions::scroll::known_bounds(element).ok_or_else(|| {
            AdapterError::new(ErrorCode::ActionFailed, "Missing scroll target bounds")
        })?;
        let viewport = viewport_bounds(ancestor)?.ok_or_else(|| {
            AdapterError::new(ErrorCode::ActionFailed, "Missing scroll viewport bounds")
        })?;
        let horizontal = matches!(direction, Direction::Left | Direction::Right);
        let (current, size, extent, offset) = if horizontal {
            (
                pattern.get_horizontal_scroll_percent(),
                pattern.get_horizontal_view_size(),
                viewport.width,
                bounds.x + bounds.width / 2.0 - viewport.x - viewport.width / 2.0,
            )
        } else {
            (
                pattern.get_vertical_scroll_percent(),
                pattern.get_vertical_view_size(),
                viewport.height,
                bounds.y + bounds.height / 2.0 - viewport.y - viewport.height / 2.0,
            )
        };
        let percent = centered_scroll_percent(
            current.map_err(|error| uia_error(&error, "read scroll position"))?,
            size.map_err(|error| uia_error(&error, "read scroll view size"))?,
            extent,
            offset,
        )?;
        deadline.ensure_remaining()?;
        corroborate_verified_process(ancestor)?;
        let (x, y) = if horizontal {
            (percent, -1.0)
        } else {
            (-1.0, percent)
        };
        match pattern.set_scroll_percent(x, y) {
            Ok(()) => {
                classify_success()?;
                Ok(())
            }
            Err(error) => require_scroll_delivery(classify_write(
                "SetScrollPercent",
                LADDER_SCROLL_LABEL,
                &error,
            )),
        }
    }

    pub(crate) fn require_scroll_delivery(
        classified: Result<bool, AdapterError>,
    ) -> Result<(), AdapterError> {
        match classified {
            Ok(true) => Ok(()),
            Ok(false) => Err(AdapterError::new(
                ErrorCode::ActionFailed,
                "ScrollPattern is not available on the scroll ancestor",
            )
            .with_disposition(DeliverySemantics::not_delivered())),
            Err(error) => Err(error),
        }
    }
}

#[cfg(not(target_os = "windows"))]
mod imp {
    use super::{AdapterError, Deadline, DeliveryOutcome, UIAElement};

    pub(crate) fn ancestor_ladder(
        _element: &UIAElement,
        _deadline: Deadline,
    ) -> Result<Option<DeliveryOutcome>, AdapterError> {
        Ok(None)
    }
}

pub(crate) use imp::ancestor_ladder;

#[cfg(target_os = "windows")]
pub(crate) use imp::observe_visibility;

#[cfg(all(test, target_os = "windows"))]
pub(crate) use imp::require_scroll_delivery;

/// Ladder seam: a scrollable ancestor replaces the unsupported / not-delivered
/// terminal; no ancestor keeps that terminal byte-identical.
pub(crate) fn apply_ladder_seam(
    fallback: AdapterError,
    ladder: Result<Option<DeliveryOutcome>, AdapterError>,
) -> Result<DeliveryOutcome, AdapterError> {
    match ladder {
        Ok(Some(outcome)) => Ok(outcome),
        Ok(None) => Err(fallback),
        Err(error) => Err(error),
    }
}

#[cfg(all(test, target_os = "windows"))]
#[path = "scroll_ladder_tests.rs"]
mod tests;
