use agent_desktop_core::tree::state;

use super::*;
use crate::tree::element::ancestry;
use crate::tree::live::test_support::{read_of, words};
use crate::tree::observe::node_evidence::evidence_for;
use crate::tree::surfaces::window_tie::WindowTie;
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

fn button() -> ObservedRead {
    let mut read = read_of(PUSH_BUTTON, "New tab", &["click"]);
    read.node.traits.states = Field::Present(words(&[ENABLED, VISIBLE, SHOWING]));
    read.node.extents = Field::Present(rect(0, 0, 34, 34));
    let mut element = AtspiElement::new(":1.1", "/p", 1);
    element.set_ancestry(ancestry::of_root(&element.clone()));
    read.node.element = element;
    read
}

fn twin_window(hidden: Option<bool>) -> Placement {
    Placement {
        node: Some(rect(40, 112, 34, 34)),
        frame: Some(rect(0, 0, 700, 520)),
        tie: Some(WindowTie { hidden }),
        ..Placement::default()
    }
}

fn state_in(placement: &Placement) -> agent_desktop_core::ElementState {
    let read = button();
    let evidence = evidence_for(&read, &read.node.element);
    live_state(&read, &evidence, placement).expect("the state projects")
}

#[test]
fn a_node_in_a_window_whose_tied_clients_are_all_shown_is_on_screen_by_its_window_geometry() {
    let projected = state_in(&twin_window(Some(false)));
    assert_eq!(projected.offscreen, Some(false));
    assert!(!projected.states.iter().any(|t| t == state::OFFSCREEN));
    assert_eq!(pointer_rect(&button(), &twin_window(Some(false))), None);
}

#[test]
fn a_node_in_a_window_whose_tied_clients_are_all_hidden_is_offscreen() {
    let projected = state_in(&twin_window(Some(true)));
    assert_eq!(projected.offscreen, Some(true));
    assert!(projected.states.iter().any(|t| t == state::OFFSCREEN));
}

#[test]
fn tied_clients_that_disagree_prove_nothing_about_the_window() {
    assert_eq!(state_in(&twin_window(None)).offscreen, None);
}

#[test]
fn without_a_tie_the_window_stays_unplaced() {
    let unplaced = Placement {
        tie: None,
        ..twin_window(Some(false))
    };
    assert_eq!(state_in(&unplaced).offscreen, None);
}
