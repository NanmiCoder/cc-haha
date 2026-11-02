use super::*;
use crate::tree::Extents;

fn facts(x: i32, y: i32, width: i32, height: i32) -> WindowFacts {
    WindowFacts {
        client: Extents {
            x,
            y,
            width,
            height,
        },
        hidden: false,
        maximized_vertical: false,
        maximized_horizontal: false,
    }
}

fn move_to(x: i32, y: i32) -> WindowWrite {
    WindowWrite::MoveResize {
        x: Some(x),
        y: Some(y),
        width: None,
        height: None,
    }
}

#[test]
fn readback_tolerance_is_two_pixels_at_the_boundary() {
    let requested = WindowWrite::MoveResize {
        x: None,
        y: None,
        width: Some(562),
        height: Some(693),
    };
    assert_eq!(
        judge(&requested, &facts(10, 10, 564, 693), true),
        Verdict::Satisfied
    );
    assert_eq!(
        judge(&requested, &facts(10, 10, 565, 693), true),
        Verdict::Mismatch
    );
}

#[test]
fn a_negative_coordinate_is_compared_as_a_signed_value() {
    assert_eq!(
        judge(&move_to(-40, -10), &facts(-40, -10, 5, 5), true),
        Verdict::Satisfied
    );
    assert_eq!(
        judge(&move_to(-40, -10), &facts(40, 10, 5, 5), true),
        Verdict::Mismatch
    );
}

#[test]
fn maximize_needs_both_atoms() {
    let mut half = facts(0, 0, 1, 1);
    half.maximized_vertical = true;
    assert_eq!(
        judge(&WindowWrite::SetMaximized(true), &half, true),
        Verdict::Mismatch
    );
    half.maximized_horizontal = true;
    assert_eq!(
        judge(&WindowWrite::SetMaximized(true), &half, true),
        Verdict::Satisfied
    );
}

#[test]
fn restore_from_maximized_needs_neither_maximized_atom() {
    let mut window = facts(0, 0, 1, 1);
    window.maximized_horizontal = true;
    assert_eq!(
        judge(&WindowWrite::SetMaximized(false), &window, true),
        Verdict::Mismatch
    );
    window.maximized_horizontal = false;
    assert_eq!(
        judge(&WindowWrite::SetMaximized(false), &window, true),
        Verdict::Satisfied
    );
}

#[test]
fn a_resize_is_judged_by_its_size_alone() {
    let resize = WindowWrite::MoveResize {
        x: None,
        y: None,
        width: Some(804),
        height: Some(599),
    };
    assert_eq!(
        judge(&resize, &facts(440, 201, 804, 599), true),
        Verdict::Satisfied
    );
    assert_eq!(
        judge(&resize, &facts(0, 0, 804, 650), true),
        Verdict::Mismatch
    );
}
