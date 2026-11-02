use crate::system::shell::fake_tree::{SENTINEL, at};
use crate::system::shell::live_state::project;
use crate::tree::Extents;
use crate::tree::live::test_support::read_of;
use crate::tree::placement::Placement;
use crate::tree::placement::visibility::derived_offscreen;
use crate::tree::vocabulary::role_numbers::PUSH_BUTTON;

fn displays() -> Vec<Extents> {
    vec![at(0, 0, 1280, 800)]
}

fn verdict(placement: &Placement) -> Option<bool> {
    let read = read_of(PUSH_BUTTON, "", &[]);
    derived_offscreen(&read, placement)
}

#[test]
fn top_bar_and_dock_nodes_outside_the_content_window_are_not_offscreen() {
    for node in [at(0, 0, 72, 32), at(1204, 0, 76, 32), at(534, 704, 192, 60)] {
        let placement = project(Some(node), Some(&displays()));
        assert_eq!(verdict(&placement), Some(false), "{node:?}");
    }
}

#[test]
fn extents_wholly_off_every_display_are_offscreen() {
    let placement = project(Some(at(-84, 549, 84, 60)), Some(&displays()));
    assert_eq!(verdict(&placement), Some(true));
}

#[test]
fn the_sentinel_position_is_offscreen() {
    let placement = project(Some(SENTINEL), Some(&displays()));
    assert_eq!(verdict(&placement), Some(true));
}

#[test]
fn a_merely_negative_origin_that_overlaps_a_display_is_not_offscreen() {
    let placement = project(Some(at(0, -1, 60, 84)), Some(&displays()));
    assert_eq!(verdict(&placement), Some(false));
}

#[test]
fn a_node_with_no_area_at_a_real_position_is_not_called_offscreen() {
    let placement = project(Some(at(0, 0, 0, 0)), Some(&displays()));
    assert_ne!(verdict(&placement), Some(true));
}

#[test]
fn unreadable_displays_prove_nothing_either_way() {
    let placement = project(Some(at(0, 0, 72, 32)), None);
    assert_eq!(placement.frame, None);
    assert_eq!(verdict(&placement), None);
    let none = project(None, Some(&displays()));
    assert_eq!(verdict(&none), None);
}
