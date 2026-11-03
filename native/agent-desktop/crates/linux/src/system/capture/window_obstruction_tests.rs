use super::*;
use crate::system::x11::FrameExtents;
use crate::system::x11::window::window_flags::WindowFlags;
use crate::system::x11::window::window_kind::WindowKind;

const TARGET: u32 = 10;

fn rect(x: i32, y: i32, width: i32, height: i32) -> Extents {
    Extents {
        x,
        y,
        width,
        height,
    }
}

fn stacked(id: u32, client: Extents) -> StackedWindow {
    StackedWindow {
        id,
        flags: WindowFlags {
            hidden: false,
            above: false,
            mapped: true,
        },
        desktop: DesktopPlacement::On(0),
        kind: WindowKind::Normal,
        client,
        extents: FrameExtents {
            left: 0,
            right: 0,
            top: 0,
            bottom: 0,
        },
        shadow: (0, 0, 0, 0),
    }
}

fn read_of(stack: Vec<StackedWindow>, override_redirect: Vec<Extents>) -> StackingRead {
    StackingRead::Ready(StackingSnapshot {
        current_desktop: Some(0),
        stack,
        override_redirect_above: override_redirect,
        override_redirect_receiving: Vec::new(),
        override_redirect_names: Vec::new(),
    })
}

fn target_rect() -> Extents {
    rect(100, 100, 400, 300)
}

fn verdict(above: StackedWindow) -> Cover {
    let read = read_of(vec![stacked(TARGET, target_rect()), above], Vec::new());
    cover(&read, TARGET, target_rect())
}

#[test]
fn a_window_above_overlapping_by_one_pixel_covers() {
    assert_eq!(verdict(stacked(11, rect(499, 399, 50, 50))), Cover::Covered);
}

#[test]
fn a_window_above_that_only_touches_an_edge_does_not_cover() {
    assert_eq!(verdict(stacked(11, rect(500, 100, 50, 50))), Cover::Clear);
    assert_eq!(verdict(stacked(11, rect(100, 400, 50, 50))), Cover::Clear);
}

#[test]
fn a_window_below_the_target_does_not_cover() {
    let read = read_of(
        vec![stacked(11, target_rect()), stacked(TARGET, target_rect())],
        Vec::new(),
    );
    assert_eq!(cover(&read, TARGET, target_rect()), Cover::Clear);
}

#[test]
fn an_override_redirect_window_above_covers() {
    let read = read_of(
        vec![stacked(TARGET, target_rect())],
        vec![rect(120, 120, 30, 30)],
    );
    assert_eq!(cover(&read, TARGET, target_rect()), Cover::Covered);
}

#[test]
fn a_minimised_window_above_does_not_cover() {
    let mut window = stacked(11, target_rect());
    window.flags.hidden = true;
    assert_eq!(verdict(window), Cover::Clear);
}

#[test]
fn an_unmapped_window_above_does_not_cover() {
    let mut window = stacked(11, target_rect());
    window.flags.mapped = false;
    assert_eq!(verdict(window), Cover::Clear);
}

#[test]
fn a_window_on_another_desktop_does_not_cover_but_a_sticky_one_does() {
    let mut elsewhere = stacked(11, target_rect());
    elsewhere.desktop = DesktopPlacement::On(1);
    assert_eq!(verdict(elsewhere), Cover::Clear);
    let mut sticky = stacked(11, target_rect());
    sticky.desktop = DesktopPlacement::Sticky;
    assert_eq!(verdict(sticky), Cover::Covered);
}

#[test]
fn the_frame_border_counts_as_part_of_the_window_above() {
    let mut window = stacked(11, rect(500, 100, 50, 50));
    assert_eq!(verdict(window.clone()), Cover::Clear);
    window.extents.left = 1;
    assert_eq!(verdict(window), Cover::Covered);
}

#[test]
fn an_unknown_desktop_above_is_unknown_not_clear() {
    let mut window = stacked(11, target_rect());
    window.desktop = DesktopPlacement::Unknown;
    assert_eq!(verdict(window), Cover::Unknown);
}

#[test]
fn a_definite_cover_wins_over_an_unknown_one() {
    let mut unknown = stacked(11, target_rect());
    unknown.desktop = DesktopPlacement::Unknown;
    let read = read_of(
        vec![
            stacked(TARGET, target_rect()),
            unknown,
            stacked(12, target_rect()),
        ],
        Vec::new(),
    );
    assert_eq!(cover(&read, TARGET, target_rect()), Cover::Covered);
}

#[test]
fn a_read_without_a_snapshot_or_without_the_target_is_unknown() {
    for read in [
        StackingRead::NotX11,
        StackingRead::NoManager,
        StackingRead::Unavailable,
    ] {
        assert_eq!(cover(&read, TARGET, target_rect()), Cover::Unknown);
    }
    let missing = read_of(vec![stacked(99, target_rect())], Vec::new());
    assert_eq!(cover(&missing, TARGET, target_rect()), Cover::Unknown);
}
