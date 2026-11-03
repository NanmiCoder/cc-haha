use agent_desktop_core::{AdapterError, Deadline, ErrorCode, Modifier, Point};

const MAX_LINES_PER_EVENT: i32 = 10;
const MAX_TOTAL_LINES: i32 = 1_000;

#[cfg(target_os = "macos")]
pub(crate) fn synthesize_scroll_at(
    point: Point,
    delta: (i32, i32),
    modifiers: &[Modifier],
    deadline: Deadline,
) -> Result<(), AdapterError> {
    use core_graphics::event::{CGEvent, CGEventTapLocation, ScrollEventUnit};
    use core_graphics::geometry::CGPoint;

    crate::input::mouse::validate_point(&point)?;
    let chunks = scroll_chunks(delta)?;
    let mut delivery = crate::actions::DeliveryTracker::default();
    crate::input::mouse::ensure_budget(deadline, delivery)?;
    crate::input::mouse::mouse_move::preposition_pointer(
        &point,
        modifiers,
        deadline,
        &mut delivery,
    )?;
    let source = crate::input::mouse::event_source().map_err(|error| delivery.annotate(error))?;
    let flags = crate::input::mouse::event_flags(modifiers);
    for (index, (dy, dx)) in chunks.iter().copied().enumerate() {
        crate::input::mouse::ensure_budget(deadline, delivery)?;
        tracing::debug!(dy, dx, "mouse: scroll chunk");
        let event = CGEvent::new_scroll_event(source.clone(), ScrollEventUnit::LINE, 2, dy, dx, 0)
            .map_err(|()| AdapterError::internal("CGEvent::new_scroll_event failed"))
            .map_err(|error| delivery.annotate(error))?;
        event.set_location(CGPoint::new(point.x, point.y));
        event.set_flags(flags);
        event.post(CGEventTapLocation::HID);
        delivery.mark_delivered();
        if index + 1 < chunks.len() {
            crate::input::mouse::sleep_bounded(
                deadline,
                std::time::Duration::from_millis(5),
                delivery,
            )?;
        }
    }
    crate::input::mouse::ensure_budget(deadline, delivery)
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn synthesize_scroll_at(
    _point: Point,
    _delta: (i32, i32),
    _modifiers: &[Modifier],
    _deadline: Deadline,
) -> Result<(), AdapterError> {
    Err(AdapterError::not_supported("scroll"))
}

fn scroll_chunks(delta: (i32, i32)) -> Result<Vec<(i32, i32)>, AdapterError> {
    let (mut dy, mut dx) = delta;
    if dy == 0 && dx == 0 {
        return Err(AdapterError::new(
            ErrorCode::InvalidArgs,
            "Wheel delta must be non-zero",
        ));
    }
    if dy.unsigned_abs() > MAX_TOTAL_LINES as u32 || dx.unsigned_abs() > MAX_TOTAL_LINES as u32 {
        return Err(AdapterError::new(
            ErrorCode::InvalidArgs,
            "Wheel delta must be within -1000..=1000 lines per axis",
        ));
    }
    let mut chunks = Vec::new();
    while dy != 0 || dx != 0 {
        let next_y = dy.clamp(-MAX_LINES_PER_EVENT, MAX_LINES_PER_EVENT);
        let next_x = dx.clamp(-MAX_LINES_PER_EVENT, MAX_LINES_PER_EVENT);
        chunks.push((next_y, next_x));
        dy -= next_y;
        dx -= next_x;
    }
    Ok(chunks)
}

#[cfg(test)]
mod tests {
    use super::{MAX_LINES_PER_EVENT, scroll_chunks};

    #[test]
    fn large_wheel_delta_is_split_into_apple_sized_signed_chunks() {
        assert_eq!(
            scroll_chunks((-25, 12)).expect("bounded wheel delta"),
            vec![(-10, 10), (-10, 2), (-5, 0)]
        );
    }

    #[test]
    fn every_wheel_chunk_stays_within_the_native_event_range() {
        let chunks = scroll_chunks((1_000, -1_000)).expect("maximum wheel delta");
        assert_eq!(chunks.len(), 100);
        assert!(chunks.iter().all(|(dy, dx)| {
            dy.abs() <= MAX_LINES_PER_EVENT && dx.abs() <= MAX_LINES_PER_EVENT
        }));
    }

    #[test]
    fn zero_and_unbounded_wheel_deltas_are_rejected() {
        assert!(scroll_chunks((0, 0)).is_err());
        assert!(scroll_chunks((1_001, 0)).is_err());
    }
}
