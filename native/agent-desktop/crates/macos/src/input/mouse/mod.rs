#[cfg(not(target_os = "macos"))]
use agent_desktop_core::DragParams;
use agent_desktop_core::{
    AdapterError, Deadline, ErrorCode, Modifier, MouseButton, MouseEvent, MouseEventKind, Point,
};

#[cfg(target_os = "macos")]
mod imp {
    use super::*;
    use core_graphics::event::{
        CGEvent, CGEventFlags, CGEventTapLocation, CGEventType, CGMouseButton, EventField,
    };
    use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};
    use core_graphics::geometry::CGPoint;

    pub(crate) fn event_flags(modifiers: &[Modifier]) -> CGEventFlags {
        modifiers.iter().fold(CGEventFlags::empty(), |flags, m| {
            flags
                | match m {
                    Modifier::Meta => CGEventFlags::CGEventFlagCommand,
                    Modifier::Shift => CGEventFlags::CGEventFlagShift,
                    Modifier::Alt => CGEventFlags::CGEventFlagAlternate,
                    Modifier::Ctrl => CGEventFlags::CGEventFlagControl,
                }
        })
    }

    pub fn synthesize_mouse(event: MouseEvent, deadline: Deadline) -> Result<(), AdapterError> {
        synthesize_mouse_after(event, deadline, &mut || Ok(()))
    }

    pub(crate) fn synthesize_mouse_after(
        event: MouseEvent,
        deadline: Deadline,
        verify_target: &mut dyn FnMut() -> Result<(), AdapterError>,
    ) -> Result<(), AdapterError> {
        tracing::debug!(kind = ?event.kind, "mouse: synthesize event");
        validate_point(&event.point)?;
        ensure_budget(deadline, crate::actions::DeliveryTracker::default())?;
        let point = CGPoint::new(event.point.x, event.point.y);
        let cg_button = to_cg_button(&event.button);
        let flags = event_flags(&event.modifiers);
        match event.kind {
            MouseEventKind::Move => {
                let mut delivery = crate::actions::DeliveryTracker::default();
                crate::input::mouse::mouse_move::post_move_events(
                    point,
                    cg_button,
                    flags,
                    deadline,
                    &mut delivery,
                )
            }
            MouseEventKind::Down | MouseEventKind::Up => Err(standalone_state_error()),
            MouseEventKind::Click { count } => {
                agent_desktop_core::validate_mouse_click_count(count)?;
                synthesize_click(
                    ClickSpec {
                        point,
                        cg_button,
                        button: &event.button,
                        count,
                        flags,
                    },
                    deadline,
                    verify_target,
                )
            }
            MouseEventKind::Wheel { delta_x, delta_y } => {
                crate::input::mouse::mouse_scroll::synthesize_scroll_at(
                    event.point,
                    (wheel_lines_to_i32(delta_y)?, wheel_lines_to_i32(delta_x)?),
                    &event.modifiers,
                    deadline,
                )
            }
        }
    }

    pub(crate) fn standalone_state_error() -> AdapterError {
        AdapterError::new(
            ErrorCode::ActionNotSupported,
            "Standalone mouse-down/mouse-up is unavailable in stateless mode",
        )
        .with_details(serde_json::json!({
            "raw_input_emitted": false,
            "requires_daemon_owned_transaction": true,
        }))
        .with_suggestion(
            "Use atomic 'mouse-click' or 'drag'; spanning holds require a daemon-owned session that can release buttons after disconnect",
        )
    }

    pub(crate) fn validate_point(point: &Point) -> Result<(), AdapterError> {
        const MAX_COORDINATE: f64 = 1_000_000.0;
        if !point.x.is_finite()
            || !point.y.is_finite()
            || point.x.abs() > MAX_COORDINATE
            || point.y.abs() > MAX_COORDINATE
        {
            return Err(AdapterError::new(
                ErrorCode::InvalidArgs,
                "Mouse coordinates must be finite and within -1000000..=1000000",
            ));
        }
        Ok(())
    }

    pub(crate) fn wheel_lines_to_i32(delta: f64) -> Result<i32, AdapterError> {
        if !delta.is_finite() || delta < f64::from(i32::MIN) || delta > f64::from(i32::MAX) {
            return Err(AdapterError::new(
                agent_desktop_core::ErrorCode::InvalidArgs,
                "Wheel line delta must be a finite 32-bit value",
            ));
        }
        let rounded = delta.round();
        if rounded == 0.0 && delta != 0.0 {
            return Ok(if delta.is_sign_positive() { 1 } else { -1 });
        }
        Ok(rounded as i32)
    }

    struct ClickSpec<'a> {
        point: CGPoint,
        cg_button: CGMouseButton,
        button: &'a MouseButton,
        count: u32,
        flags: CGEventFlags,
    }

    fn synthesize_click(
        spec: ClickSpec,
        deadline: Deadline,
        verify_target: &mut dyn FnMut() -> Result<(), AdapterError>,
    ) -> Result<(), AdapterError> {
        let down_ty = down_type(spec.button);
        let up_ty = up_type(spec.button);
        let mut delivery = crate::actions::DeliveryTracker::default();
        crate::input::mouse::mouse_move::post_move_events(
            spec.point,
            spec.cg_button,
            spec.flags,
            deadline,
            &mut delivery,
        )?;
        for i in 1..=spec.count {
            ensure_budget(deadline, delivery)?;
            let down = create_event(down_ty, spec.point, spec.cg_button, spec.flags)
                .map_err(|error| delivery.annotate(error))?;
            let up = create_event(up_ty, spec.point, spec.cg_button, spec.flags)
                .map_err(|error| delivery.annotate(error))?;
            set_click_count(&down, i as i64);
            set_click_count(&up, i as i64);
            ensure_budget(deadline, delivery)?;
            verify_target().map_err(|error| delivery.annotate(error))?;
            down.post(CGEventTapLocation::HID);
            delivery.mark_delivered();
            let mut release = ClickReleaseGuard { event: Some(up) };
            sleep_bounded(deadline, std::time::Duration::from_millis(10), delivery)?;
            let up = release
                .event
                .take()
                .ok_or_else(|| {
                    AdapterError::internal("Mouse click release guard lost its pending event")
                })
                .map_err(|error| delivery.annotate(error))?;
            up.post(CGEventTapLocation::HID);
            ensure_budget(deadline, delivery)?;
            if i < spec.count {
                sleep_bounded(deadline, std::time::Duration::from_millis(30), delivery)?;
            }
        }
        Ok(())
    }

    struct ClickReleaseGuard {
        event: Option<CGEvent>,
    }

    impl Drop for ClickReleaseGuard {
        fn drop(&mut self) {
            if let Some(event) = self.event.take() {
                event.post(CGEventTapLocation::HID);
            }
        }
    }

    fn set_click_count(event: &CGEvent, count: i64) {
        event.set_integer_value_field(EventField::MOUSE_EVENT_CLICK_STATE, count);
    }

    pub(crate) fn create_event(
        event_type: CGEventType,
        point: CGPoint,
        button: CGMouseButton,
        flags: CGEventFlags,
    ) -> Result<CGEvent, AdapterError> {
        let source = event_source()?;
        create_event_with_source(&source, event_type, point, button, flags)
    }

    pub(crate) fn create_event_with_source(
        source: &CGEventSource,
        event_type: CGEventType,
        point: CGPoint,
        button: CGMouseButton,
        flags: CGEventFlags,
    ) -> Result<CGEvent, AdapterError> {
        let event = CGEvent::new_mouse_event(source.clone(), event_type, point, button)
            .map_err(|()| AdapterError::internal("CGEvent::new_mouse_event failed"))?;
        event.set_flags(flags);
        Ok(event)
    }

    pub(crate) fn event_source() -> Result<CGEventSource, AdapterError> {
        CGEventSource::new(CGEventSourceStateID::HIDSystemState)
            .map_err(|()| AdapterError::internal("Failed to create CGEventSource"))
    }

    pub(crate) fn post_event_with_source(
        source: &CGEventSource,
        event: (CGEventType, CGPoint, CGMouseButton, CGEventFlags),
        deadline: Deadline,
        delivery: &mut crate::actions::DeliveryTracker,
    ) -> Result<(), AdapterError> {
        ensure_budget(deadline, *delivery)?;
        let ev = create_event_with_source(source, event.0, event.1, event.2, event.3)
            .map_err(|error| delivery.annotate(error))?;
        ev.post(CGEventTapLocation::HID);
        delivery.mark_delivered();
        ensure_budget(deadline, *delivery)
    }

    fn to_cg_button(button: &MouseButton) -> CGMouseButton {
        match button {
            MouseButton::Left => CGMouseButton::Left,
            MouseButton::Right => CGMouseButton::Right,
            MouseButton::Middle => CGMouseButton::Center,
        }
    }

    fn down_type(button: &MouseButton) -> CGEventType {
        match button {
            MouseButton::Left => CGEventType::LeftMouseDown,
            MouseButton::Right => CGEventType::RightMouseDown,
            MouseButton::Middle => CGEventType::OtherMouseDown,
        }
    }

    fn up_type(button: &MouseButton) -> CGEventType {
        match button {
            MouseButton::Left => CGEventType::LeftMouseUp,
            MouseButton::Right => CGEventType::RightMouseUp,
            MouseButton::Middle => CGEventType::OtherMouseUp,
        }
    }

    pub(crate) fn sleep_bounded(
        deadline: Deadline,
        duration: std::time::Duration,
        delivery: crate::actions::DeliveryTracker,
    ) -> Result<(), AdapterError> {
        let pause = deadline
            .remaining_slice(duration)
            .map_err(|error| delivery.annotate(error))?;
        if pause < duration {
            std::thread::sleep(pause);
            return ensure_budget(deadline, delivery);
        }
        std::thread::sleep(duration);
        ensure_budget(deadline, delivery)
    }

    pub(crate) fn ensure_budget(
        deadline: Deadline,
        delivery: crate::actions::DeliveryTracker,
    ) -> Result<(), AdapterError> {
        if !deadline.is_expired() {
            return Ok(());
        }
        Err(
            delivery.annotate(deadline.timeout_error().with_details(serde_json::json!({
                "delivered_events": delivery.delivered_units(),
            }))),
        )
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    use super::*;

    pub fn synthesize_mouse(_event: MouseEvent, _deadline: Deadline) -> Result<(), AdapterError> {
        Err(AdapterError::not_supported("mouse_event"))
    }

    pub(crate) fn synthesize_mouse_after(
        _event: MouseEvent,
        _deadline: Deadline,
        _verify_target: &mut dyn FnMut() -> Result<(), AdapterError>,
    ) -> Result<(), AdapterError> {
        Err(AdapterError::not_supported("mouse_event"))
    }

    pub fn synthesize_drag(_params: DragParams, _deadline: Deadline) -> Result<(), AdapterError> {
        Err(AdapterError::not_supported("drag"))
    }
}

pub(crate) use imp::{synthesize_mouse, synthesize_mouse_after};

#[cfg(target_os = "macos")]
pub(crate) use crate::input::mouse::mouse_drag::synthesize_drag;

#[cfg(not(target_os = "macos"))]
pub(crate) use imp::synthesize_drag;

#[cfg(target_os = "macos")]
pub(crate) use imp::{
    create_event_with_source, ensure_budget, event_flags, event_source, post_event_with_source,
    sleep_bounded, validate_point,
};

#[cfg(all(test, target_os = "macos", feature = "interactive-tests"))]
pub(crate) use imp::{create_event, standalone_state_error, wheel_lines_to_i32};

#[cfg(all(test, target_os = "macos", not(feature = "interactive-tests")))]
pub(crate) use imp::{standalone_state_error, wheel_lines_to_i32};

#[cfg(target_os = "macos")]
pub(super) mod mouse_drag;
#[cfg(target_os = "macos")]
pub(super) mod mouse_drag_state;
pub(crate) mod mouse_move;
pub(crate) mod mouse_scroll;
#[cfg(all(test, target_os = "macos"))]
#[path = "mouse_tests.rs"]
mod tests;
