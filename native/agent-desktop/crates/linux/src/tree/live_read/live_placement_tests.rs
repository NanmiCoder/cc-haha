use agent_desktop_core::tree::state;

use super::*;
use crate::system::process::toolkit_id::ToolkitId;
use crate::system::x11::window::window_x11_state::WindowX11State;
use crate::tree::element::ancestry::{self, Ancestry};
use crate::tree::live::test_support::{read_of, words};
use crate::tree::observe::node_evidence::evidence_for;
use crate::tree::vocabulary::role_numbers::PUSH_BUTTON;
use crate::tree::vocabulary::state_bits::{ENABLED, SHOWING, VISIBLE};
use crate::tree::{AtspiElement, Extents, Field};

fn rect(x: i32, y: i32, width: i32, height: i32) -> Extents {
    Extents {
        x,
        y,
        width,
        height,
    }
}

fn read_with(bits: &[u32], at: Option<Extents>) -> ObservedRead {
    let mut read = read_of(PUSH_BUTTON, "row", &[]);
    read.node.traits.states = Field::Present(words(bits));
    if let Some(at) = at {
        read.node.extents = Field::Present(at);
    }
    let mut element = AtspiElement::new(":1.1", "/p", 1);
    element.set_ancestry(ancestry::of_root(&element.clone()));
    read.node.element = element;
    read
}

fn inside_a_container(mut read: ObservedRead) -> ObservedRead {
    let frame = AtspiElement::new(":1.1", "/p", 1);
    let pane = AtspiElement::new(":1.1", "/pane", 1);
    read.node
        .element
        .set_ancestry(Ancestry::of(Some(frame), Some(pane), false));
    read
}

fn mapped(hidden: bool) -> Option<WindowX11State> {
    Some(WindowX11State {
        shadow: (0, 0, 0, 0),
        client_id: 7,
        hidden,
        client_origin: (302, 260),
    })
}

fn window(node: Extents) -> Placement {
    Placement {
        node: Some(node),
        frame: Some(rect(0, 0, 420, 420)),
        x11: mapped(false),
        ..Placement::default()
    }
}

fn state_in(read: &ObservedRead, placement: &Placement) -> agent_desktop_core::ElementState {
    let evidence = evidence_for(read, &read.node.element);
    live_state(read, &evidence, placement).expect("the state projects")
}

#[test]
fn a_web_node_with_visible_and_no_showing_inside_the_frame_is_not_hidden_or_offscreen() {
    let read = read_with(&[ENABLED, VISIBLE], Some(rect(542, 119, 304, 35)));
    let projected = state_in(&read, &window(rect(40, 112, 304, 35)));
    assert!(!projected.states.iter().any(|t| t == state::HIDDEN));
    assert!(!projected.states.iter().any(|t| t == state::OFFSCREEN));
    assert_eq!(projected.offscreen, Some(false));
    assert!(state::is_visible(live_bounds(&read), &projected.states));
}

#[test]
fn a_node_with_neither_bit_is_hidden_and_is_never_called_on_screen() {
    let read = read_with(&[ENABLED], Some(rect(0, 0, 10, 10)));
    let projected = state_in(&read, &window(rect(0, 0, 10, 10)));
    assert!(projected.states.iter().any(|t| t == state::HIDDEN));
    assert!(!state::is_visible(live_bounds(&read), &projected.states));
    assert_eq!(projected.offscreen, None);
    assert_eq!(projected.hidden, None);
}

#[test]
fn a_hidden_node_on_a_rectangle_far_outside_the_window_is_hidden_and_offscreen() {
    let read = read_with(&[ENABLED], Some(rect(1, 4501, 464, 18)));
    let projected = state_in(&read, &window(rect(1, 4501, 464, 18)));
    assert!(projected.states.iter().any(|t| t == state::HIDDEN));
    assert!(projected.states.iter().any(|t| t == state::OFFSCREEN));
    assert_eq!(projected.offscreen, Some(true));
}

#[test]
fn the_gtk3_sentinel_row_is_offscreen_with_its_token_and_needs_no_placement() {
    let read = read_with(&[ENABLED, VISIBLE], Some(rect(i32::MIN, i32::MIN, 420, 22)));
    assert!(settled_by_read(&read));
    let projected = state_in(&read, &Placement::default());
    assert_eq!(projected.offscreen, Some(true));
    assert!(projected.states.iter().any(|t| t == state::OFFSCREEN));
    assert!(!state::is_visible(live_bounds(&read), &projected.states));
}

#[test]
fn a_sentinel_row_that_is_showing_is_not_the_gtk3_shape() {
    let read = read_with(
        &[ENABLED, VISIBLE, SHOWING],
        Some(rect(i32::MIN, i32::MIN, 1, 1)),
    );
    assert!(!settled_by_read(&read));
    assert_eq!(derived_offscreen(&read, &Placement::default()), None);
}

#[test]
fn a_gtk4_row_far_below_the_frame_is_offscreen_and_one_inside_is_on_screen() {
    let read = read_with(&[ENABLED, VISIBLE, SHOWING], Some(rect(0, 0, 420, 22)));
    assert!(!settled_by_read(&read));
    let below = state_in(&read, &window(rect(2, 5526, 420, 22)));
    assert_eq!(below.offscreen, Some(true));
    assert!(below.states.iter().any(|t| t == state::OFFSCREEN));
    let within = state_in(&read, &window(rect(2, 100, 420, 22)));
    assert_eq!(within.offscreen, Some(false));
    assert!(!within.states.iter().any(|t| t == state::OFFSCREEN));
}

#[test]
fn an_unread_frame_or_container_never_makes_a_node_on_screen() {
    let read = read_with(&[ENABLED, VISIBLE, SHOWING], Some(rect(0, 0, 420, 22)));
    let mut unframed = window(rect(2, 100, 420, 22));
    unframed.frame = None;
    assert_eq!(derived_offscreen(&read, &unframed), None);

    let boxed = inside_a_container(read);
    let unread = window(rect(2, 100, 420, 22));
    assert_eq!(derived_offscreen(&boxed, &unread), None);
    let mut read_container = window(rect(2, 100, 420, 22));
    read_container.container = Some(rect(0, 0, 420, 420));
    assert_eq!(derived_offscreen(&boxed, &read_container), Some(false));
    read_container.node = Some(rect(2, 5526, 420, 22));
    assert_eq!(derived_offscreen(&boxed, &read_container), Some(true));
    let mut unread_below = unread;
    unread_below.node = Some(rect(2, 5526, 420, 22));
    assert_eq!(derived_offscreen(&boxed, &unread_below), Some(true));
}

#[test]
fn a_partly_clipped_row_is_offscreen_when_its_center_is_outside_the_container() {
    let read = inside_a_container(read_with(
        &[ENABLED, VISIBLE, SHOWING],
        Some(rect(0, 90, 100, 30)),
    ));
    let mut placed = window(rect(0, 90, 100, 30));
    placed.container = Some(rect(0, 0, 420, 100));
    assert_eq!(state_in(&read, &placed).offscreen, Some(true));
    placed.node = Some(rect(0, 80, 100, 30));
    assert_eq!(state_in(&read, &placed).offscreen, Some(false));
}

#[test]
fn an_iconified_frame_or_a_hidden_x11_window_makes_every_node_offscreen() {
    let read = read_with(&[ENABLED, VISIBLE, SHOWING], Some(rect(0, 0, 10, 10)));
    let mut iconified = window(rect(2, 100, 420, 22));
    iconified.frame_iconified = Some(true);
    assert_eq!(derived_offscreen(&read, &iconified), Some(true));
    let mut hidden = window(rect(2, 100, 420, 22));
    hidden.x11 = mapped(true);
    assert_eq!(derived_offscreen(&read, &hidden), Some(true));
    let mut unknown = window(rect(2, 100, 420, 22));
    unknown.x11 = None;
    assert_eq!(derived_offscreen(&read, &unknown), None);
}

#[test]
fn a_global_toolkit_keeps_its_extents_and_another_has_no_bounds_when_unprovable() {
    let mut read = read_with(&[ENABLED, VISIBLE, SHOWING], Some(rect(100, 137, 420, 34)));
    let evidence = evidence_for(&read, &read.node.element);
    let global =
        live_element(&read, &evidence, &Placement::default(), true).expect("global projects");
    assert_eq!(global.bounds.map(|b| (b.x, b.y)), Some((100.0, 137.0)));
    let mut unprovable = window(rect(0, 0, 420, 34));
    unprovable.node = None;
    let other = live_element(&read, &evidence, &unprovable, false).expect("projects");
    assert_eq!(other.bounds, None);

    read.node.extents = Field::Absent;
    let evidence = evidence_for(&read, &read.node.element);
    let other =
        live_element(&read, &evidence, &window(rect(0, 0, 420, 34)), false).expect("projects");
    assert_eq!(other.bounds, None);
}

fn gtk(version: &str) -> ToolkitId {
    ToolkitId {
        name: Some("GTK".to_owned()),
        version: Some(version.to_owned()),
    }
}

fn on_screen_1280x800(mut placement: Placement) -> Placement {
    placement.displays = Some(vec![rect(0, 0, 1280, 800)]);
    placement
}

#[test]
fn a_node_wholly_outside_every_display_is_offscreen_and_a_partly_visible_one_is_not() {
    let mut placed = on_screen_1280x800(window(rect(10, 10, 100, 40)));
    placed.toolkit = gtk("3.24.41");
    let outside = read_with(
        &[ENABLED, VISIBLE, SHOWING],
        Some(rect(-308, -156, 100, 40)),
    );
    assert_eq!(derived_offscreen(&outside, &placed), Some(true));
    let projected = state_in(&outside, &placed);
    assert!(projected.states.iter().any(|t| t == state::OFFSCREEN));
    let partly = read_with(&[ENABLED, VISIBLE, SHOWING], Some(rect(1260, 10, 100, 40)));
    assert_eq!(derived_offscreen(&partly, &placed), Some(false));
}

#[test]
fn a_node_outside_every_display_is_not_called_offscreen_without_a_display_list() {
    let mut placed = window(rect(10, 10, 100, 40));
    placed.toolkit = gtk("3.24.41");
    let outside = read_with(
        &[ENABLED, VISIBLE, SHOWING],
        Some(rect(-308, -156, 100, 40)),
    );
    assert_eq!(derived_offscreen(&outside, &placed), Some(false));
    placed.displays = Some(Vec::new());
    assert_eq!(derived_offscreen(&outside, &placed), Some(false));
}

#[test]
fn a_node_of_a_toolkit_without_global_position_is_judged_by_its_provable_rectangle() {
    let read = read_with(&[ENABLED, VISIBLE, SHOWING], Some(rect(0, 0, 100, 40)));
    let mut placed = on_screen_1280x800(window(rect(0, 0, 100, 40)));
    placed.toolkit = gtk("4.14.5");
    placed.x11 = Some(WindowX11State {
        shadow: (0, 0, 0, 0),
        client_id: 7,
        hidden: false,
        client_origin: (-308, -156),
    });
    assert_eq!(derived_offscreen(&read, &placed), Some(true));
    placed.x11 = mapped(false);
    assert_eq!(derived_offscreen(&read, &placed), Some(false));
}

#[test]
fn a_client_side_shadow_moves_the_pointer_rectangle_from_the_client_origin_inside_it() {
    let read = read_with(&[ENABLED, VISIBLE, SHOWING], Some(rect(0, 0, 498, 34)));
    let mut placed = window(rect(16, 306, 64, 44));
    placed.toolkit = ToolkitId {
        name: Some("GTK".to_owned()),
        version: Some("4.14.5".to_owned()),
    };
    placed.x11 = Some(WindowX11State {
        shadow: (61, 55, 0, 0),
        client_id: 7,
        hidden: false,
        client_origin: (37, 64),
    });

    let aimed = pointer_rect(&read, &placed).expect("a pointer rectangle");

    assert_eq!((aimed.x, aimed.y), (114.0, 425.0));
}
