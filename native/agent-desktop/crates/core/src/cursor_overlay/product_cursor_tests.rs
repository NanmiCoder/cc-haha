use super::*;

#[test]
fn product_arrow_keeps_the_action_point_at_its_tip_and_a_notched_tail() {
    assert_eq!(PRODUCT_CURSOR_ARROW[0], (0.0, 0.0));
    assert_eq!(PRODUCT_CURSOR_ARROW[1].0, 0.0);
    assert!(PRODUCT_CURSOR_ARROW[2].1 < PRODUCT_CURSOR_ARROW[1].1);
    assert!(PRODUCT_CURSOR_ARROW[3].1 > PRODUCT_CURSOR_ARROW[2].1);
    assert!(PRODUCT_CURSOR_ARROW[4].0 > PRODUCT_CURSOR_ARROW[3].0);
    assert!(PRODUCT_CURSOR_ARROW.iter().all(|&(x, y)| {
        x >= 0.0 && x <= PRODUCT_CURSOR_WIDTH && y >= 0.0 && y <= PRODUCT_CURSOR_HEIGHT
    }));
    assert_eq!(PRODUCT_CURSOR_OUTLINE, 1.5);
}

#[test]
fn product_arrow_uses_the_swift_helpers_twenty_two_point_reference() {
    let reference = [
        (0.0, 0.0),
        (0.0, 16.5),
        (4.0, 12.7),
        (6.6, 18.5),
        (9.2, 17.4),
        (6.6, 11.6),
        (11.6, 11.2),
    ];
    for ((x, y), (expected_x, expected_y)) in PRODUCT_CURSOR_ARROW.iter().zip(reference) {
        assert!((x * 19.0 / 22.0 - expected_x).abs() < 1e-10);
        assert!((y * 19.0 / 22.0 - expected_y).abs() < 1e-10);
    }
}
