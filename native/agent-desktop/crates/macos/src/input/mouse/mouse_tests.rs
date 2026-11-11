use super::{Modifier, event_flags, standalone_state_error, wheel_lines_to_i32};
use core_graphics::event::CGEventFlags;

#[test]
fn standalone_mouse_state_is_rejected_without_emission() {
    let error = standalone_state_error();

    assert_eq!(
        error.code,
        agent_desktop_core::ErrorCode::ActionNotSupported
    );
    assert_eq!(error.details.unwrap()["raw_input_emitted"], false);
}

#[test]
fn event_flags_maps_cmd_to_command_bit() {
    assert_eq!(
        event_flags(&[Modifier::Meta]),
        CGEventFlags::CGEventFlagCommand
    );
}

#[test]
fn event_flags_maps_shift_to_shift_bit() {
    assert_eq!(
        event_flags(&[Modifier::Shift]),
        CGEventFlags::CGEventFlagShift
    );
}

#[test]
fn event_flags_maps_alt_to_alternate_bit() {
    assert_eq!(
        event_flags(&[Modifier::Alt]),
        CGEventFlags::CGEventFlagAlternate
    );
}

#[test]
fn event_flags_maps_ctrl_to_control_bit() {
    assert_eq!(
        event_flags(&[Modifier::Ctrl]),
        CGEventFlags::CGEventFlagControl
    );
}

#[test]
fn event_flags_combines_multiple_modifiers_via_bitwise_or() {
    let combined = event_flags(&[Modifier::Meta, Modifier::Shift]);
    assert_eq!(
        combined,
        CGEventFlags::CGEventFlagCommand | CGEventFlags::CGEventFlagShift
    );
    assert!(combined.contains(CGEventFlags::CGEventFlagCommand));
    assert!(combined.contains(CGEventFlags::CGEventFlagShift));
    assert!(!combined.contains(CGEventFlags::CGEventFlagAlternate));
}

#[test]
fn event_flags_empty_slice_yields_no_flags() {
    assert_eq!(event_flags(&[]), CGEventFlags::empty());
}

#[test]
fn wheel_line_conversion_preserves_direction_and_small_nonzero_input() {
    assert_eq!(wheel_lines_to_i32(-3.0).unwrap(), -3);
    assert_eq!(wheel_lines_to_i32(2.6).unwrap(), 3);
    assert_eq!(wheel_lines_to_i32(0.1).unwrap(), 1);
    assert_eq!(wheel_lines_to_i32(-0.1).unwrap(), -1);
}

#[test]
fn wheel_line_conversion_rejects_non_finite_input() {
    assert!(wheel_lines_to_i32(f64::NAN).is_err());
    assert!(wheel_lines_to_i32(f64::INFINITY).is_err());
}

#[cfg(feature = "interactive-tests")]
#[test]
fn native_cg_event_contract_is_bounded() {
    use super::create_event;
    use crate::input::interactive_test::{is_worker, run_bounded};
    use core_graphics::event::{CGEventType, CGMouseButton};
    use core_graphics::geometry::CGPoint;
    use std::time::Duration;

    if is_worker("mouse") {
        let flags = event_flags(&[Modifier::Meta, Modifier::Ctrl]);
        let event = create_event(
            CGEventType::LeftMouseDown,
            CGPoint::new(0.0, 0.0),
            CGMouseButton::Left,
            flags,
        )
        .expect("CGEvent construction succeeds");
        assert_eq!(event.get_flags(), flags);

        let plain = create_event(
            CGEventType::LeftMouseUp,
            CGPoint::new(0.0, 0.0),
            CGMouseButton::Left,
            event_flags(&[]),
        )
        .expect("second CGEvent construction succeeds");
        assert_eq!(plain.get_flags(), CGEventFlags::empty());
    } else {
        run_bounded(
            "native_cg_event_contract_is_bounded",
            "mouse",
            Duration::from_secs(5),
        );
    }
}
