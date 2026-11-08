use super::rect_of;
use windows_sys::Win32::Foundation::RECT;

/// The conversion every caller depends on: far edges in, size out. A version
/// that carried `right` and `bottom` through unchanged would still produce a
/// rectangle, and a monitor at a non-zero origin would come back the size of
/// the whole virtual desktop.
#[test]
fn far_edges_become_a_size_rather_than_being_carried_through() {
    let converted = rect_of(&RECT {
        left: 100,
        top: 40,
        right: 340,
        bottom: 200,
    });

    assert_eq!(converted.x, 100.0);
    assert_eq!(converted.y, 40.0);
    assert_eq!(converted.width, 240.0, "width is right minus left");
    assert_eq!(converted.height, 160.0, "height is bottom minus top");
}

/// A monitor left of the primary has a negative origin, and its size is still
/// positive. Reading the origin as a magnitude would place it on the wrong
/// side of the desktop, which is the failure a cursor drawn on that monitor
/// would show first.
#[test]
fn a_negative_origin_keeps_its_sign_and_still_yields_a_positive_size() {
    let converted = rect_of(&RECT {
        left: -1920,
        top: -180,
        right: 0,
        bottom: 900,
    });

    assert_eq!(converted.x, -1920.0);
    assert_eq!(converted.y, -180.0);
    assert_eq!(converted.width, 1920.0);
    assert_eq!(converted.height, 1080.0);
}

/// An inverted rectangle is a read that went wrong. It is reported as the
/// negative size it is rather than clamped, so a caller sees a measurement
/// that cannot be real instead of an empty box that looks ordinary.
#[test]
fn an_inverted_rectangle_answers_a_negative_size_rather_than_nothing() {
    let converted = rect_of(&RECT {
        left: 500,
        top: 500,
        right: 100,
        bottom: 100,
    });

    assert!(converted.width < 0.0);
    assert!(converted.height < 0.0);
}

/// An empty rectangle is a legitimate answer and must not be confused with a
/// faulted one.
#[test]
fn an_empty_rectangle_is_zero_sized_rather_than_negative() {
    let converted = rect_of(&RECT {
        left: 7,
        top: 9,
        right: 7,
        bottom: 9,
    });

    assert_eq!(converted.width, 0.0);
    assert_eq!(converted.height, 0.0);
}
