use super::*;

fn rect(x: i32, y: i32, width: i32, height: i32) -> Extents {
    Extents {
        x,
        y,
        width,
        height,
    }
}

const SCREEN: Extents = Extents {
    x: 0,
    y: 0,
    width: 1280,
    height: 800,
};

#[test]
fn only_positive_area_overlap_with_any_known_display_counts_as_on_screen() {
    let right = rect(1280, 0, 800, 600);
    let displays = [SCREEN, right];
    let cases = [
        (Some(rect(-308, -156, 100, 40)), Some(&[SCREEN][..]), true),
        (Some(rect(-100, 10, 100, 40)), Some(&[SCREEN][..]), true),
        (Some(rect(1280, 10, 100, 40)), Some(&[SCREEN][..]), true),
        (Some(rect(10, 800, 100, 40)), Some(&[SCREEN][..]), true),
        (Some(rect(1260, 10, 100, 40)), Some(&[SCREEN][..]), false),
        (Some(rect(-50, -20, 100, 40)), Some(&[SCREEN][..]), false),
        (Some(rect(10, 10, 100, 40)), Some(&[SCREEN][..]), false),
        (Some(rect(1500, 10, 50, 20)), Some(&displays[..]), false),
        (Some(rect(2200, 10, 50, 20)), Some(&displays[..]), true),
        (None, Some(&[SCREEN][..]), false),
        (Some(rect(-500, 0, 10, 10)), None, false),
        (Some(rect(-500, 0, 10, 10)), Some(&[][..]), false),
        (Some(rect(-500, 0, 0, 10)), Some(&[SCREEN][..]), false),
        (Some(rect(-500, 0, -10, 10)), Some(&[SCREEN][..]), false),
        (Some(rect(0, 0, 10, 0)), Some(&[SCREEN][..]), false),
        (
            Some(rect(i32::MIN, i32::MIN, 10, 10)),
            Some(&[SCREEN][..]),
            false,
        ),
    ];
    for (node, displays, expected_off) in cases {
        assert_eq!(off_every_display(node, displays), expected_off, "{node:?}");
    }
}
