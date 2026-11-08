use super::*;

fn size(width: i32, height: i32) -> Extents {
    Extents {
        x: 0,
        y: 0,
        width,
        height,
    }
}

fn bounds(width: f64, height: f64) -> Option<Rect> {
    Some(Rect {
        x: 0.0,
        y: 0.0,
        width,
        height,
    })
}

#[test]
fn a_frame_two_percent_off_fails_the_strict_check_but_the_client_check_is_looser() {
    let frame = size(1019, 737);
    assert_eq!(
        choose(size(500, 500), Some(frame), bounds(1000.0, 737.0)),
        Unit::Unproven
    );
    assert_eq!(choose(frame, None, bounds(1000.0, 737.0)), Unit::Client);
}
