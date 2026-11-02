use super::*;
use crate::tree::hit_test::tests::rect;

const FRAME: Extents = Extents {
    x: 0,
    y: 0,
    width: 420,
    height: 420,
};

fn input(node: Option<Extents>) -> OffscreenInput {
    OffscreenInput {
        node,
        frame: Some(FRAME),
        container: None,
        visible: true,
        showing: true,
        sentinel: false,
        minimized: Some(false),
    }
}

#[test]
fn frame_edges_and_container_geometry_remain_three_valued() {
    assert_eq!(offscreen(input(Some(rect(0, 444, 100, 20)))), None);
    assert_eq!(offscreen(input(Some(rect(0, 445, 100, 20)))), Some(true));
    assert_eq!(offscreen(input(Some(rect(2, 410, 100, 40)))), Some(false));
    assert_eq!(offscreen(input(Some(rect(2, 5526, 420, 22)))), Some(true));
    assert_eq!(
        offscreen(input(Some(rect(i32::MAX - 3, 0, 10, 10)))),
        Some(true)
    );

    let mut row = input(Some(rect(0, 300, 100, 20)));
    row.container = Some(rect(0, 0, 420, 100));
    assert_eq!(offscreen(row), Some(true));
    row.node = Some(rect(0, 50, 100, 20));
    assert_eq!(offscreen(row), Some(false));
    row.node = Some(rect(0, 110, 100, 20));
    assert_eq!(offscreen(row), None);

    row.node = Some(rect(0, 50, 100, 20));
    row.container = Some(rect(0, 0, 420, 0));
    assert_eq!(offscreen(row), None);
    row.container = Some(rect(i32::MIN, i32::MIN, 420, 360));
    assert_eq!(offscreen(row), Some(false));
    row.node = Some(rect(0, 5526, 420, 22));
    assert_eq!(offscreen(row), Some(true));
}

#[test]
fn unusable_inputs_stay_unknown_and_minimized_state_proves_offscreen() {
    assert_eq!(offscreen(input(None)), None);
    assert_eq!(offscreen(input(Some(rect(0, 5000, 710, 0)))), None);
    assert_eq!(offscreen(input(Some(rect(0, 5000, -1, 10)))), None);
    assert_eq!(offscreen(input(Some(rect(i32::MIN, i32::MIN, 5, 5)))), None);

    let mut unframed = input(Some(rect(0, 5000, 10, 10)));
    unframed.frame = None;
    assert_eq!(offscreen(unframed), None);

    let mut row = input(None);
    row.minimized = Some(true);
    row.frame = None;
    assert_eq!(offscreen(row), Some(true));
    row.minimized = None;
    row.sentinel = true;
    row.visible = true;
    row.showing = false;
    assert_eq!(offscreen(row), Some(true));
    row.visible = false;
    assert_eq!(offscreen(row), None);

    let mut web = input(Some(rect(40, 112, 304, 35)));
    web.showing = false;
    assert_eq!(offscreen(web), Some(false));
    web.minimized = None;
    assert_eq!(offscreen(web), None);
}
