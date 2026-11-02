use agent_desktop_core::{
    AdapterError, Deadline, DeliverySemantics, ErrorCode, InteractionPolicy, MouseButton,
    MouseEvent, MouseEventKind, Point,
};

use crate::tree::AXElement;

pub(crate) struct PhysicalClick {
    pub(crate) button: MouseButton,
    pub(crate) count: u32,
    pub(crate) verified_point: Option<Point>,
}

pub(crate) fn click_via_bounds(
    element: &AXElement,
    click: PhysicalClick,
    policy: InteractionPolicy,
    deadline: Deadline,
) -> Result<(), AdapterError> {
    if !policy.allow_cursor_move || !policy.allow_focus_steal {
        return Err(AdapterError::policy_denied_for_policy(
            "Physical click fallback is disabled by the current interaction policy",
            policy,
        ));
    }
    let prepared =
        crate::actions::physical_target::PreparedPhysicalTarget::prepare(element, deadline)?;
    let read_deadline = crate::tree::locator_deadline::from_operation(deadline)?;
    let bounds = crate::tree::element_bounds::read_bounds_with_deadline(element, read_deadline)?
        .ok_or_else(|| {
            AdapterError::new(ErrorCode::ActionFailed, "Element has no readable bounds")
                .with_suggestion("AX action failed and CGEvent fallback unavailable")
        })?;
    if bounds.width <= 0.0 || bounds.height <= 0.0 {
        return Err(
            AdapterError::new(ErrorCode::ActionFailed, "Element has zero-size bounds")
                .with_suggestion("Element may be hidden or off-screen. Try 'scroll-to' first."),
        );
    }
    let point = delivery_point(bounds, click.verified_point.as_ref())?;
    crate::input::mouse::validate_point(&point)?;
    tracing::debug!(
        button = ?click.button,
        count = click.count,
        x = point.x,
        y = point.y,
        "AX action failed, falling back to CGEvent click"
    );
    let mut verify_target = || prepared.verify_pointer(element, &point, deadline);
    crate::input::mouse::synthesize_mouse_after(
        MouseEvent {
            kind: MouseEventKind::Click { count: click.count },
            point: point.clone(),
            button: click.button,
            modifiers: Vec::new(),
        },
        deadline,
        &mut verify_target,
    )
}

fn delivery_point(
    bounds: agent_desktop_core::Rect,
    verified: Option<&Point>,
) -> Result<Point, AdapterError> {
    let point = verified.cloned().unwrap_or(Point {
        x: bounds.x + bounds.width / 2.0,
        y: bounds.y + bounds.height / 2.0,
    });
    if point.x < bounds.x
        || point.x > bounds.x + bounds.width
        || point.y < bounds.y
        || point.y > bounds.y + bounds.height
    {
        return Err(AdapterError::new(
            ErrorCode::StaleRef,
            "Actionability-verified input point is outside the target's live bounds",
        )
        .with_suggestion("Run 'snapshot' to refresh, then retry with the updated ref.")
        .with_disposition(DeliverySemantics::not_delivered()));
    }
    Ok(point)
}

#[cfg(test)]
#[path = "physical_click_tests.rs"]
mod tests;
