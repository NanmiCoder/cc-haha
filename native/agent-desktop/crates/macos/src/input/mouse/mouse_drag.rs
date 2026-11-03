use agent_desktop_core::{AdapterError, CursorMotion, Deadline, DragParams, ErrorCode};
use core_graphics::event::{CGEvent, CGEventFlags, CGEventTapLocation, CGEventType, CGMouseButton};
use core_graphics::event_source::CGEventSource;
use core_graphics::geometry::CGPoint;
use std::time::Duration;

const DEFAULT_DURATION_MS: u64 = 300;
const PICKUP_DELAY_MS: u64 = 200;
const DEFAULT_DROP_DELAY_MS: u64 = 500;
const DWELL_TICK_MS: u64 = 16;
const MAX_STEPS: u64 = 4_096;
const MAX_DRAG_MS: u64 = 60_000;
const MAX_DROP_DELAY_MS: u64 = 30_000;

pub(crate) fn synthesize_drag(params: DragParams, deadline: Deadline) -> Result<(), AdapterError> {
    validate_drag(&params)?;
    preflight_drag(&params, deadline)?;
    drag_sequence(params, deadline)
}

fn drag_sequence(params: DragParams, deadline: Deadline) -> Result<(), AdapterError> {
    tracing::debug!(
        duration_ms = params.duration_ms.unwrap_or(DEFAULT_DURATION_MS),
        "mouse: drag"
    );
    let from = CGPoint::new(params.from.x, params.from.y);
    let to = CGPoint::new(params.to.x, params.to.y);
    let duration_ms = params.duration_ms.unwrap_or(DEFAULT_DURATION_MS);
    let motion = CursorMotion::new(params.from.clone(), params.to.clone());
    let steps = duration_ms.div_ceil(DWELL_TICK_MS).clamp(1, MAX_STEPS);
    let step_delay = Duration::from_secs_f64(duration_ms as f64 / steps as f64 / 1_000.0);
    let pre_delivery = crate::actions::DeliveryTracker::default();
    let source =
        crate::input::mouse::event_source().map_err(|error| pre_delivery.annotate(error))?;
    let down = crate::input::mouse::create_event_with_source(
        &source,
        CGEventType::LeftMouseDown,
        from,
        CGMouseButton::Left,
        CGEventFlags::empty(),
    )
    .map_err(|error| pre_delivery.annotate(error))?;
    let mut release = DragReleaseGuard::prepare(&source, from, to)
        .map_err(|error| pre_delivery.annotate(error))?;
    crate::input::mouse::ensure_budget(deadline, pre_delivery)?;
    release.arm();
    down.post(CGEventTapLocation::HID);
    release.mark_down_posted();

    let outcome = (|| {
        crate::input::mouse::ensure_budget(deadline, release.delivery())?;
        crate::input::mouse::sleep_bounded(
            deadline,
            Duration::from_millis(PICKUP_DELAY_MS),
            release.delivery(),
        )?;

        for index in 1..=steps {
            let point = drag_point(&motion, index, steps);
            crate::input::mouse::post_event_with_source(
                &source,
                (
                    CGEventType::LeftMouseDragged,
                    point,
                    CGMouseButton::Left,
                    CGEventFlags::empty(),
                ),
                deadline,
                release.delivery_mut(),
            )?;
            crate::input::mouse::sleep_bounded(deadline, step_delay, release.delivery())?;
        }

        dwell_over_destination(
            &source,
            to,
            params.drop_delay_ms.unwrap_or(DEFAULT_DROP_DELAY_MS),
            deadline,
            release.delivery_mut(),
        )?;
        release.release_at_destination(deadline)
    })();
    outcome.map_err(|error| release.enrich_error(error))
}

fn drag_point(motion: &CursorMotion, index: u64, steps: u64) -> CGPoint {
    let point = motion.sample(motion.duration_ms() * index / steps);
    CGPoint::new(point.x, point.y)
}

struct DragReleaseGuard {
    abort_drag: CGEvent,
    abort_up: CGEvent,
    destination_up: Option<CGEvent>,
    delivery: crate::input::mouse::mouse_drag_state::DragDeliveryState,
}

impl DragReleaseGuard {
    fn prepare(
        source: &CGEventSource,
        origin: CGPoint,
        destination: CGPoint,
    ) -> Result<Self, AdapterError> {
        let flags = CGEventFlags::empty();
        Ok(Self {
            abort_drag: crate::input::mouse::create_event_with_source(
                source,
                CGEventType::LeftMouseDragged,
                origin,
                CGMouseButton::Left,
                flags,
            )?,
            abort_up: crate::input::mouse::create_event_with_source(
                source,
                CGEventType::LeftMouseUp,
                origin,
                CGMouseButton::Left,
                flags,
            )?,
            destination_up: Some(crate::input::mouse::create_event_with_source(
                source,
                CGEventType::LeftMouseUp,
                destination,
                CGMouseButton::Left,
                flags,
            )?),
            delivery: crate::input::mouse::mouse_drag_state::DragDeliveryState::default(),
        })
    }

    fn arm(&mut self) {
        self.delivery.arm();
    }

    fn mark_down_posted(&mut self) {
        self.delivery.mark_down_posted();
    }

    fn delivery(&self) -> crate::actions::DeliveryTracker {
        self.delivery.delivery()
    }

    fn delivery_mut(&mut self) -> &mut crate::actions::DeliveryTracker {
        self.delivery.delivery_mut()
    }

    fn release_at_destination(&mut self, deadline: Deadline) -> Result<(), AdapterError> {
        crate::input::mouse::ensure_budget(deadline, self.delivery())?;
        let event = self.destination_up.take().ok_or_else(|| {
            AdapterError::internal("Drag release guard lost its destination event")
        })?;
        event.post(CGEventTapLocation::HID);
        self.delivery.disarm();
        crate::input::mouse::ensure_budget(deadline, self.delivery())
    }

    fn enrich_error(&self, error: AdapterError) -> AdapterError {
        self.delivery.enrich_error(error)
    }
}

impl Drop for DragReleaseGuard {
    fn drop(&mut self) {
        if self.delivery.should_release() {
            self.abort_drag.post(CGEventTapLocation::HID);
            self.abort_up.post(CGEventTapLocation::HID);
        }
    }
}

fn dwell_over_destination(
    source: &CGEventSource,
    destination: CGPoint,
    delay_ms: u64,
    deadline: Deadline,
    delivery: &mut crate::actions::DeliveryTracker,
) -> Result<(), AdapterError> {
    if delay_ms == 0 {
        return Ok(());
    }
    let mut remaining_ms = delay_ms;
    while remaining_ms > 0 {
        crate::input::mouse::post_event_with_source(
            source,
            (
                CGEventType::LeftMouseDragged,
                destination,
                CGMouseButton::Left,
                CGEventFlags::empty(),
            ),
            deadline,
            delivery,
        )?;
        let tick_ms = remaining_ms.min(DWELL_TICK_MS);
        crate::input::mouse::sleep_bounded(deadline, Duration::from_millis(tick_ms), *delivery)?;
        remaining_ms -= tick_ms;
    }
    Ok(())
}

fn preflight_drag(params: &DragParams, deadline: Deadline) -> Result<(), AdapterError> {
    let duration_ms = params.duration_ms.unwrap_or(DEFAULT_DURATION_MS);
    let drop_delay_ms = params.drop_delay_ms.unwrap_or(DEFAULT_DROP_DELAY_MS);
    let required_ms = PICKUP_DELAY_MS
        .checked_add(duration_ms)
        .and_then(|total| total.checked_add(drop_delay_ms))
        .ok_or_else(|| AdapterError::new(ErrorCode::InvalidArgs, "Drag timing is too large"))?;
    let remaining = deadline.remaining();
    let required = Duration::from_millis(required_ms);
    if remaining < required {
        return Err(crate::actions::DeliveryTracker::default().annotate(
            AdapterError::timeout("Drag cannot complete within the remaining deadline")
                .with_details(serde_json::json!({
                    "physical_delivery_started": false,
                    "required_ms": required_ms,
                    "remaining_ms": remaining.as_millis(),
                })),
        ));
    }
    Ok(())
}

fn validate_drag(params: &DragParams) -> Result<(), AdapterError> {
    crate::input::mouse::validate_point(&params.from)?;
    crate::input::mouse::validate_point(&params.to)?;
    if params.duration_ms.is_some_and(|value| value > MAX_DRAG_MS) {
        return Err(AdapterError::new(
            ErrorCode::InvalidArgs,
            "Drag duration must not exceed 60000ms",
        ));
    }
    if params
        .drop_delay_ms
        .is_some_and(|value| value > MAX_DROP_DELAY_MS)
    {
        return Err(AdapterError::new(
            ErrorCode::InvalidArgs,
            "Drag drop delay must not exceed 30000ms",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use agent_desktop_core::Point;

    #[test]
    fn drag_reuses_cursor_motion_and_lands_exactly() {
        let motion = CursorMotion::new(Point { x: 10.0, y: 20.0 }, Point { x: 400.0, y: 200.0 });
        let midpoint = motion.sample(motion.duration_ms() / 2);
        let halfway = drag_point(&motion, 5, 10);
        let end = drag_point(&motion, 10, 10);
        assert_eq!((halfway.x, halfway.y), (midpoint.x, midpoint.y));
        assert_eq!((end.x, end.y), (400.0, 200.0));
        assert_ne!((halfway.x, halfway.y), (205.0, 110.0));
    }

    #[test]
    fn drag_limits_reject_unbounded_work() {
        let base = DragParams {
            from: Point { x: 0.0, y: 0.0 },
            to: Point { x: 10.0, y: 10.0 },
            duration_ms: Some(MAX_DRAG_MS + 1),
            drop_delay_ms: None,
        };
        assert!(validate_drag(&base).is_err());
        let excessive_dwell = DragParams {
            duration_ms: None,
            drop_delay_ms: Some(MAX_DROP_DELAY_MS + 1),
            ..base
        };
        assert!(validate_drag(&excessive_dwell).is_err());
    }

    #[test]
    fn impossible_drag_deadline_fails_before_mouse_down() {
        let params = DragParams {
            from: Point { x: 0.0, y: 0.0 },
            to: Point { x: 10.0, y: 10.0 },
            duration_ms: Some(1),
            drop_delay_ms: Some(0),
        };
        let error = preflight_drag(&params, Deadline::after(1).unwrap()).unwrap_err();

        assert_eq!(error.code, ErrorCode::Timeout);
        assert_eq!(error.details.unwrap()["physical_delivery_started"], false);
    }
}
