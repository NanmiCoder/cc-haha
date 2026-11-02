use agent_desktop_core::{
    AdapterError, Deadline, Direction, ErrorCode, InteractionPolicy, StepMechanism,
};

use crate::tree::AXElement;

const MAX_SCROLL_AMOUNT: u32 = 1_000;

pub(crate) fn ax_scroll(
    element: &AXElement,
    direction: &Direction,
    amount: u32,
    policy: InteractionPolicy,
    deadline: Deadline,
) -> Result<(StepMechanism, bool), AdapterError> {
    validate_amount(amount)?;
    let scroll_area = find_scroll_area(element, deadline)?;
    let target = scroll_area.as_ref().unwrap_or(element);
    if policy.is_headed() {
        physical_wheel(target, direction, amount, deadline)?;
        return Ok((StepMechanism::PhysicalSynthetic, false));
    }
    let (bar_attribute, increment_action) = scroll_bar_action(direction);

    if let Some(bar) = crate::actions::scroll_read::element(target, bar_attribute, deadline)? {
        if perform_repeated_action(&bar, increment_action, amount, deadline)? {
            return Ok((StepMechanism::SemanticApi, false));
        }
        if try_value_shift(&bar, direction, amount, deadline)? {
            return Ok((StepMechanism::SemanticApi, true));
        }
        if try_sub_elements(&bar, direction, amount, deadline)? {
            return Ok((StepMechanism::SemanticApi, false));
        }
    }
    if perform_repeated_action(target, page_action(direction), amount, deadline)? {
        return Ok((StepMechanism::SemanticApi, false));
    }
    Err(AdapterError::new(
        ErrorCode::ActionNotSupported,
        "Element advertises Scroll but no scroll mechanism moved its content",
    )
    .with_details(serde_json::json!({
        "kind": "scroll_advertised_but_inert",
    }))
    .with_suggestion(
        "The application publishes the scroll actions without implementing them. \
         Try the parent container, or use '--headed' for a physical wheel scroll.",
    ))
}

fn validate_amount(amount: u32) -> Result<(), AdapterError> {
    if amount == 0 || amount > MAX_SCROLL_AMOUNT {
        return Err(AdapterError::new(
            ErrorCode::InvalidArgs,
            "Scroll amount must be between 1 and 1000",
        ));
    }
    Ok(())
}

fn scroll_bar_action(direction: &Direction) -> (&'static str, &'static str) {
    match direction {
        Direction::Down => ("AXVerticalScrollBar", "AXIncrement"),
        Direction::Up => ("AXVerticalScrollBar", "AXDecrement"),
        Direction::Right => ("AXHorizontalScrollBar", "AXIncrement"),
        Direction::Left => ("AXHorizontalScrollBar", "AXDecrement"),
    }
}

fn page_action(direction: &Direction) -> &'static str {
    match direction {
        Direction::Down => "AXScrollDownByPage",
        Direction::Up => "AXScrollUpByPage",
        Direction::Right => "AXScrollRightByPage",
        Direction::Left => "AXScrollLeftByPage",
    }
}

fn perform_repeated_action(
    element: &AXElement,
    action: &'static str,
    amount: u32,
    deadline: Deadline,
) -> Result<bool, AdapterError> {
    repeat_action(action, amount, || try_action(element, action, deadline))
}

fn repeat_action(
    action: &'static str,
    amount: u32,
    mut attempt: impl FnMut() -> Result<bool, AdapterError>,
) -> Result<bool, AdapterError> {
    for completed in 0..amount {
        match attempt() {
            Ok(true) => {}
            Ok(false) if completed == 0 => return Ok(false),
            Ok(false) => return Err(partial_scroll_error(action, completed, amount, None)),
            Err(error) if completed == 0 => return Err(error),
            Err(error) => {
                return Err(partial_scroll_error(action, completed, amount, Some(error)));
            }
        }
    }
    Ok(true)
}

fn try_action(element: &AXElement, action: &str, deadline: Deadline) -> Result<bool, AdapterError> {
    prepare(element, deadline)?;
    let result = crate::actions::ax_helpers::try_ax_action_or_err(element, action, deadline);
    ensure_budget(deadline, result.as_ref().is_ok_and(|delivered| *delivered))?;
    result
}

fn partial_scroll_error(
    action: &str,
    completed: u32,
    requested: u32,
    source: Option<AdapterError>,
) -> AdapterError {
    let mut details = serde_json::json!({
        "action_may_have_completed": true,
        "completed_steps": completed,
        "requested_steps": requested,
    });
    if let Some(source) = source.as_ref() {
        details["source_code"] = source.code.as_str().into();
        details["source_message"] = source.message.as_str().into();
    }
    AdapterError::new(
        source.map_or(ErrorCode::ActionFailed, |error| error.code),
        format!("{action} stopped after {completed} of {requested} requested scroll steps"),
    )
    .with_details(details)
    .with_disposition(agent_desktop_core::DeliverySemantics::delivered_unverified())
    .with_suggestion("Inspect the current scroll position before deciding whether to retry.")
}

fn try_value_shift(
    bar: &AXElement,
    direction: &Direction,
    amount: u32,
    deadline: Deadline,
) -> Result<bool, AdapterError> {
    use core_foundation::{base::TCFType, number::CFNumber, string::CFString};

    let Some(current) = crate::actions::scroll_read::number(bar, "AXValue", deadline)? else {
        return Ok(false);
    };
    let next = shifted_value(current, direction, amount);
    if (next - current).abs() <= f64::EPSILON {
        return Ok(false);
    }
    prepare(bar, deadline)?;
    let value = CFNumber::from(next as f32);
    let attribute = CFString::new("AXValue");
    let error = crate::tree::properties::ax_ipc::set_attribute_value(
        bar,
        attribute.as_concrete_TypeRef(),
        value.as_CFTypeRef(),
        deadline,
    )?;
    let result = crate::actions::ax_mutation::classify_result(
        bar,
        "AXValue",
        "AXUIElementSetAttributeValue",
        error,
    );
    ensure_budget(deadline, result.as_ref().is_ok_and(|delivered| *delivered))?;
    if !result? {
        return Ok(false);
    }
    let observed = crate::actions::scroll_read::number(bar, "AXValue", deadline)
        .map_err(value_write_unverified)?
        .ok_or_else(|| value_write_unverified(missing_value_after_write()))?;
    if value_shift_verified(current, observed, direction) {
        return Ok(true);
    }
    Err(value_write_unverified(AdapterError::new(
        ErrorCode::ActionFailed,
        "Scrollbar AXValue write completed without the requested movement",
    )))
}

fn shifted_value(current: f64, direction: &Direction, amount: u32) -> f64 {
    let delta = 0.1 * f64::from(amount);
    match direction {
        Direction::Down | Direction::Right => (current + delta).min(1.0),
        Direction::Up | Direction::Left => (current - delta).max(0.0),
    }
}

fn value_shift_verified(current: f64, observed: f64, direction: &Direction) -> bool {
    match direction {
        Direction::Down | Direction::Right => observed > current + f64::EPSILON,
        Direction::Up | Direction::Left => observed < current - f64::EPSILON,
    }
}

fn missing_value_after_write() -> AdapterError {
    AdapterError::new(
        ErrorCode::ActionFailed,
        "Scrollbar AXValue disappeared after a successful write",
    )
}

fn value_write_unverified(error: AdapterError) -> AdapterError {
    error
        .with_disposition(agent_desktop_core::DeliverySemantics::delivered_unverified())
        .with_suggestion("Inspect the current scroll position before deciding whether to retry.")
}

fn try_sub_elements(
    bar: &AXElement,
    direction: &Direction,
    amount: u32,
    deadline: Deadline,
) -> Result<bool, AdapterError> {
    let children = crate::actions::scroll_read::children(bar, deadline)?;
    let subroles = match direction {
        Direction::Down | Direction::Right => &["AXIncrementPage", "AXIncrementArrow"],
        Direction::Up | Direction::Left => &["AXDecrementPage", "AXDecrementArrow"],
    };
    for child in children {
        if crate::actions::scroll_read::string(&child, "AXSubrole", deadline)?
            .is_some_and(|subrole| subroles.contains(&subrole.as_str()))
            && perform_repeated_action(&child, "AXPress", amount, deadline)?
        {
            return Ok(true);
        }
    }
    Ok(false)
}

pub(crate) fn find_scroll_area(
    element: &AXElement,
    deadline: Deadline,
) -> Result<Option<AXElement>, AdapterError> {
    let mut current = Some(element.clone());
    for _ in 0..=5 {
        let Some(candidate) = current else {
            return Ok(None);
        };
        if crate::actions::scroll_read::string(&candidate, "AXRole", deadline)?.as_deref()
            == Some("AXScrollArea")
        {
            return Ok(Some(candidate));
        }
        current = crate::actions::scroll_read::element(&candidate, "AXParent", deadline)?;
    }
    Ok(None)
}

fn physical_wheel(
    target: &AXElement,
    direction: &Direction,
    amount: u32,
    deadline: Deadline,
) -> Result<(), AdapterError> {
    let prepared =
        crate::actions::physical_target::PreparedPhysicalTarget::prepare(target, deadline)?;
    let bounds =
        crate::tree::hit_test::visible_bounds_ax_element(target, deadline)?.ok_or_else(|| {
            AdapterError::new(
                ErrorCode::ActionFailed,
                "Scroll target has no visible delivery area",
            )
        })?;
    let (vertical, horizontal) = wheel_delta(direction, amount);
    let point = agent_desktop_core::Point {
        x: bounds.x + bounds.width / 2.0,
        y: bounds.y + bounds.height / 2.0,
    };
    prepared.verify_pointer(target, &point, deadline)?;
    crate::input::mouse::mouse_scroll::synthesize_scroll_at(
        point,
        (vertical, horizontal),
        &[],
        deadline,
    )
}

fn wheel_delta(direction: &Direction, amount: u32) -> (i32, i32) {
    let units = amount.min(i32::MAX as u32) as i32;
    match direction {
        Direction::Down => (-units, 0),
        Direction::Up => (units, 0),
        Direction::Right => (0, units),
        Direction::Left => (0, -units),
    }
}

#[cfg(test)]
fn scroll_wheel_delta(direction: &Direction, amount: u32) -> (i32, i32) {
    wheel_delta(direction, amount)
}

fn prepare(element: &AXElement, deadline: Deadline) -> Result<(), AdapterError> {
    crate::tree::properties::attributes::set_messaging_timeout(element, deadline)
}

fn ensure_budget(deadline: Deadline, delivery_started: bool) -> Result<(), AdapterError> {
    if !deadline.is_expired() {
        return Ok(());
    }
    let mut delivery = crate::actions::DeliveryTracker::default();
    if delivery_started {
        delivery.mark_delivered();
    }
    Err(delivery.annotate(deadline.timeout_error()))
}

#[cfg(test)]
#[path = "scroll_tests.rs"]
mod tests;
