use super::*;

const TARGET: GrabRect = GrabRect {
    x: 0,
    y: 0,
    width: 100,
    height: 80,
};

#[test]
fn a_report_over_the_whole_target_covers_it() {
    assert!(DamageBounds::of(0, 0, 100, 80).covers(TARGET));
    assert!(DamageBounds::of(-5, -5, 200, 200).covers(TARGET));
}

#[test]
fn a_partial_report_does_not_cover_the_target() {
    assert!(!DamageBounds::of(0, 0, 10, 10).covers(TARGET));
    assert!(!DamageBounds::of(0, 0, 100, 79).covers(TARGET));
    assert!(!DamageBounds::of(1, 0, 100, 80).covers(TARGET));
}

#[test]
fn reports_that_meet_cover_the_target_together() {
    let top = DamageBounds::of(0, 0, 100, 40);
    let bottom = DamageBounds::of(0, 40, 100, 40);
    assert!(top.merged(bottom).covers(TARGET));
}

#[test]
fn an_empty_target_is_never_covered() {
    let empty = GrabRect { width: 0, ..TARGET };
    assert!(!DamageBounds::of(0, 0, 100, 80).covers(empty));
}
