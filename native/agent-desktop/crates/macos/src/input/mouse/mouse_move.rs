#[cfg(target_os = "macos")]
use agent_desktop_core::{AdapterError, Deadline, ErrorCode, Modifier, Point};
#[cfg(target_os = "macos")]
use core_graphics::{
    event::{CGEvent, CGEventFlags, CGEventTapLocation, CGEventType, CGMouseButton},
    geometry::CGPoint,
};

#[cfg(target_os = "macos")]
pub(crate) fn post_move_events(
    point: CGPoint,
    button: CGMouseButton,
    flags: CGEventFlags,
    deadline: Deadline,
    delivery: &mut crate::actions::DeliveryTracker,
) -> Result<(), AdapterError> {
    let source = crate::input::mouse::event_source().map_err(|error| delivery.annotate(error))?;
    for position in [approach_point(point), point] {
        crate::input::mouse::ensure_budget(deadline, *delivery)?;
        let event = crate::input::mouse::create_event_with_source(
            &source,
            CGEventType::MouseMoved,
            position,
            button,
            flags,
        )
        .map_err(|error| delivery.annotate(error))?;
        event.post(CGEventTapLocation::HID);
        delivery.mark_delivered();
        crate::input::mouse::sleep_bounded(
            deadline,
            std::time::Duration::from_millis(10),
            *delivery,
        )?;
    }
    verify_position(source, point, deadline, delivery)
}

#[cfg(target_os = "macos")]
fn verify_position(
    source: core_graphics::event_source::CGEventSource,
    requested: CGPoint,
    deadline: Deadline,
    delivery: &mut crate::actions::DeliveryTracker,
) -> Result<(), AdapterError> {
    let verification_end = std::time::Instant::now() + std::time::Duration::from_millis(100);
    loop {
        let observed = CGEvent::new(source.clone())
            .map_err(|()| AdapterError::internal("Failed to read the current pointer position"))
            .map_err(|error| delivery.annotate(error))?
            .location();
        if pointer_position_matches(observed, requested) {
            return Ok(());
        }
        if std::time::Instant::now() >= verification_end {
            return Err(pointer_position_error(observed, requested, delivery));
        }
        crate::input::mouse::sleep_bounded(
            deadline,
            std::time::Duration::from_millis(5),
            *delivery,
        )?;
    }
}

#[cfg(target_os = "macos")]
fn pointer_position_error(
    observed: CGPoint,
    requested: CGPoint,
    delivery: &crate::actions::DeliveryTracker,
) -> AdapterError {
    delivery.annotate(
        AdapterError::new(
            ErrorCode::ActionFailed,
            "Physical pointer did not reach the requested position",
        )
        .with_details(serde_json::json!({
            "requested": { "x": requested.x, "y": requested.y },
            "observed": { "x": observed.x, "y": observed.y },
        })),
    )
}

#[cfg(target_os = "macos")]
pub(crate) fn preposition_pointer(
    point: &Point,
    modifiers: &[Modifier],
    deadline: Deadline,
    delivery: &mut crate::actions::DeliveryTracker,
) -> Result<(), AdapterError> {
    post_move_events(
        CGPoint::new(point.x, point.y),
        CGMouseButton::Left,
        crate::input::mouse::event_flags(modifiers),
        deadline,
        delivery,
    )
}

#[cfg(target_os = "macos")]
fn approach_point(point: CGPoint) -> CGPoint {
    CGPoint::new(
        if point.x > -999_999.0 {
            point.x - 1.0
        } else {
            point.x + 1.0
        },
        point.y,
    )
}

#[cfg(target_os = "macos")]
fn pointer_position_matches(observed: CGPoint, requested: CGPoint) -> bool {
    (observed.x - requested.x).abs() <= 0.5 && (observed.y - requested.y).abs() <= 0.5
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::{approach_point, pointer_position_matches};
    use core_graphics::geometry::CGPoint;

    #[test]
    fn approach_moves_one_point_before_the_exact_destination() {
        let approach = approach_point(CGPoint::new(2065.0, 636.0));
        assert_eq!(approach.x, 2064.0);
        assert_eq!(approach.y, 636.0);
    }

    #[test]
    fn verification_allows_subpixel_rounding_only() {
        let requested = CGPoint::new(2065.0, 636.0);
        assert!(pointer_position_matches(
            CGPoint::new(2065.4, 635.6),
            requested
        ));
        assert!(!pointer_position_matches(
            CGPoint::new(2065.6, 636.0),
            requested
        ));
    }
}
