//! ScrollPattern directional scroll with per-axis honesty (A19-8).
//!
//! Gates `ScrollAvailable` on the element, maps direction to
//! SmallIncrement/SmallDecrement on one axis, invokes `amount` times under the
//! deadline, and verifies by scroll-percent delta or bounds change.

use agent_desktop_core::{ActionStep, AdapterError, Deadline, Direction, ErrorCode, Rect};

use crate::actions::chain::{DeliveryOutcome, build_step};
use crate::tree::element::UIAElement;

pub(crate) const SCROLL_LABEL: &str = "ScrollPattern.Scroll";

const MAX_SCROLL_AMOUNT: u32 = 1_000;

#[cfg(target_os = "windows")]
pub(crate) fn scroll_amounts(
    direction: &Direction,
) -> (
    uiautomation::types::ScrollAmount,
    uiautomation::types::ScrollAmount,
) {
    use uiautomation::types::ScrollAmount;

    match direction {
        Direction::Down => (ScrollAmount::NoAmount, ScrollAmount::SmallIncrement),
        Direction::Up => (ScrollAmount::NoAmount, ScrollAmount::SmallDecrement),
        Direction::Right => (ScrollAmount::SmallIncrement, ScrollAmount::NoAmount),
        Direction::Left => (ScrollAmount::SmallDecrement, ScrollAmount::NoAmount),
    }
}

/// Injected scroll plan shared by the live path and unit-test seam.
pub(crate) struct ScrollPlan {
    pub(crate) scroll_available: bool,
    pub(crate) axis_scrollable: bool,
    pub(crate) axis_name: &'static str,
    pub(crate) amount: u32,
}

pub(crate) fn axis_name(direction: &Direction) -> &'static str {
    match direction {
        Direction::Up | Direction::Down => "vertical",
        Direction::Left | Direction::Right => "horizontal",
    }
}

/// Percent-delta wins when both samples exist; otherwise bounds change.
pub(crate) fn scroll_effect_verified(
    before_percent: Option<f64>,
    after_percent: Option<f64>,
    before_bounds: Option<Rect>,
    after_bounds: Option<Rect>,
) -> bool {
    match (before_percent, after_percent) {
        (Some(before), Some(after)) if (after - before).abs() > f64::EPSILON => true,
        _ => match (before_bounds, after_bounds) {
            (Some(before), Some(after)) => before.bounds_hash() != after.bounds_hash(),
            _ => false,
        },
    }
}

#[cfg(target_os = "windows")]
mod imp {
    use super::{
        ActionStep, AdapterError, Deadline, DeliveryOutcome, Direction, ErrorCode,
        MAX_SCROLL_AMOUNT, SCROLL_LABEL, ScrollPlan, UIAElement, axis_name, build_step,
        scroll_amounts, scroll_effect_verified,
    };
    use crate::actions::mutation::{classify_success, classify_write};
    use crate::tree::properties::property_ids::TreeProperty;
    use crate::tree::properties::read_one;
    use agent_desktop_core::{DeliverySemantics, LocatorField, Rect};
    use uiautomation::patterns::UIScrollPattern;

    pub(crate) fn scroll_steps(
        element: &UIAElement,
        direction: &Direction,
        amount: u32,
        deadline: Deadline,
    ) -> Result<Vec<ActionStep>, AdapterError> {
        validate_amount(amount)?;
        let scroll_available =
            read_one(element, TreeProperty::ScrollAvailable).flag() == Some(true);
        let pattern = if scroll_available {
            element.0.get_pattern::<UIScrollPattern>().ok()
        } else {
            None
        };
        let axis = axis_name(direction);
        let axis_scrollable = pattern
            .as_ref()
            .map(|pattern| axis_is_scrollable(pattern, direction))
            .unwrap_or(false);
        let before_percent = pattern
            .as_ref()
            .and_then(|pattern| read_percent(pattern, direction));
        let before_bounds = known_bounds(element);
        let (horizontal, vertical) = scroll_amounts(direction);
        let mut scroll_once = || {
            let Some(pattern) = pattern.as_ref() else {
                return Ok(());
            };
            let delivered = match pattern.scroll(horizontal, vertical) {
                Ok(()) => classify_success()?,
                Err(error) => classify_write("Scroll", SCROLL_LABEL, &error)?,
            };
            if delivered {
                Ok(())
            } else {
                Err(axis_not_scrollable(axis))
            }
        };
        let mut observe = || {
            let after_percent = pattern
                .as_ref()
                .and_then(|pattern| read_percent(pattern, direction));
            let after_bounds = known_bounds(element);
            scroll_effect_verified(before_percent, after_percent, before_bounds, after_bounds)
        };
        scroll_judged_for(
            deadline,
            ScrollPlan {
                scroll_available,
                axis_scrollable,
                axis_name: axis,
                amount,
            },
            &mut scroll_once,
            &mut observe,
        )
    }

    pub(crate) fn scroll_judged_for(
        deadline: Deadline,
        plan: ScrollPlan,
        scroll_once: &mut dyn FnMut() -> Result<(), AdapterError>,
        observe_effect: &mut dyn FnMut() -> bool,
    ) -> Result<Vec<ActionStep>, AdapterError> {
        deadline.ensure_remaining()?;
        validate_amount(plan.amount)?;
        if !plan.scroll_available {
            return Err(scroll_unavailable());
        }
        if !plan.axis_scrollable {
            return Err(axis_not_scrollable(plan.axis_name));
        }
        for completed in 0..plan.amount {
            deadline.ensure_remaining().map_err(|error| {
                if completed == 0 {
                    error
                } else {
                    partial_scroll_error(error, completed, plan.amount)
                }
            })?;
            scroll_once().map_err(|error| {
                if completed == 0 {
                    error
                } else {
                    partial_scroll_error(error, completed, plan.amount)
                }
            })?;
        }
        let verified = observe_effect();
        Ok(vec![build_step(
            SCROLL_LABEL,
            DeliveryOutcome::from_delivery(true, verified),
        )])
    }

    fn axis_is_scrollable(pattern: &UIScrollPattern, direction: &Direction) -> bool {
        match direction {
            Direction::Up | Direction::Down => pattern.is_vertically_scrollable().unwrap_or(false),
            Direction::Left | Direction::Right => {
                pattern.is_horizontally_scrollable().unwrap_or(false)
            }
        }
    }

    fn read_percent(pattern: &UIScrollPattern, direction: &Direction) -> Option<f64> {
        match direction {
            Direction::Up | Direction::Down => pattern.get_vertical_scroll_percent().ok(),
            Direction::Left | Direction::Right => pattern.get_horizontal_scroll_percent().ok(),
        }
    }

    /// The one bounds-or-`None` read shared with `scroll_into_view`'s
    /// before/after comparison.
    pub(crate) fn known_bounds(element: &UIAElement) -> Option<Rect> {
        match read_one(element, TreeProperty::BoundingRectangle).bounds() {
            LocatorField::Known(bounds) => Some(bounds),
            _ => None,
        }
    }

    fn validate_amount(amount: u32) -> Result<(), AdapterError> {
        if amount == 0 || amount > MAX_SCROLL_AMOUNT {
            return Err(AdapterError::new(
                ErrorCode::InvalidArgs,
                format!("Scroll amount must be between 1 and {MAX_SCROLL_AMOUNT}"),
            ));
        }
        Ok(())
    }

    fn scroll_unavailable() -> AdapterError {
        AdapterError::new(
            ErrorCode::ActionFailed,
            "ScrollPattern is not available on this element",
        )
        .with_disposition(DeliverySemantics::not_delivered())
        .with_suggestion(
            "Target an element that advertises Scroll, or scroll a containing viewport.",
        )
    }

    fn axis_not_scrollable(axis: &str) -> AdapterError {
        AdapterError::new(
            ErrorCode::ActionFailed,
            format!("The {axis} axis is not scrollable"),
        )
        .with_disposition(DeliverySemantics::not_delivered())
        .with_details(serde_json::json!({
            "kind": "axis_not_scrollable",
            "axis": axis,
        }))
        .with_suggestion(
            "Scroll along the axis the control exposes, or target a different container.",
        )
    }

    /// Re-frames a mid-run failure as a partial scroll without replacing what
    /// went wrong.
    ///
    /// The steps already delivered change the *disposition* - the caller must
    /// re-read before retrying - but not the cause. Stamping every partial
    /// scroll `ACTION_FAILED` erased exactly the distinction a caller acts on:
    /// a budget that ran out is retryable with a longer one, and a control
    /// that refused the step is not. The original code is kept and its
    /// message carried in `platform_detail`.
    fn partial_scroll_error(cause: AdapterError, completed: u32, requested: u32) -> AdapterError {
        AdapterError::new(
            cause.code,
            format!("ScrollPattern.Scroll stopped after {completed} of {requested} requested scroll steps"),
        )
        .with_platform_detail(cause.message)
        .with_details(serde_json::json!({
            "action_may_have_completed": true,
            "completed_steps": completed,
            "requested_steps": requested,
        }))
        .with_disposition(DeliverySemantics::delivered_unverified())
        .with_suggestion("Inspect the current scroll position before deciding whether to retry.")
    }
}

#[cfg(not(target_os = "windows"))]
mod imp {
    use super::{ActionStep, AdapterError, Deadline, Direction, ScrollPlan, UIAElement};

    pub(crate) fn scroll_steps(
        _element: &UIAElement,
        _direction: &Direction,
        _amount: u32,
        _deadline: Deadline,
    ) -> Result<Vec<ActionStep>, AdapterError> {
        Err(AdapterError::not_supported("Scroll"))
    }

    pub(crate) fn scroll_judged_for(
        _deadline: Deadline,
        _plan: ScrollPlan,
        _scroll_once: &mut dyn FnMut() -> Result<(), AdapterError>,
        _observe_effect: &mut dyn FnMut() -> bool,
    ) -> Result<Vec<ActionStep>, AdapterError> {
        Err(AdapterError::not_supported("Scroll"))
    }
}

pub(crate) use imp::scroll_steps;

#[cfg(target_os = "windows")]
pub(crate) use imp::known_bounds;

#[cfg(all(test, target_os = "windows"))]
pub(crate) use imp::scroll_judged_for;

#[cfg(all(test, target_os = "windows"))]
#[path = "scroll_tests.rs"]
mod tests;
