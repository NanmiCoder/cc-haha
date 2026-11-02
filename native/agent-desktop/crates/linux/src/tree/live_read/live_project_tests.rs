use agent_desktop_core::{ErrorCode, LocatorEvidence, Rect, tree::state};

use super::*;
use crate::tree::live::test_support::{read_of, words};
use crate::tree::observe::node_evidence::evidence_for;
use crate::tree::vocabulary::role_numbers::{PASSWORD_TEXT, PUSH_BUTTON, SLIDER};
use crate::tree::vocabulary::state_bits::{ENABLED, READ_ONLY, SENSITIVE, SHOWING, VISIBLE};
use crate::tree::{AtspiElement, Extents, Field, element::ancestry};

fn framed() -> AtspiElement {
    let mut element = AtspiElement::new(":1.1", "/p", 1);
    element.set_ancestry(ancestry::of_root(&element.clone()));
    element
}

fn evidence_of(read: &ObservedRead) -> LocatorEvidence {
    evidence_for(read, &framed())
}

fn with_states(mut read: ObservedRead, bits: &[u32]) -> ObservedRead {
    read.node.traits.states = Field::Present(words(bits));
    read
}

fn with_extents(mut read: ObservedRead, x: i32, y: i32, width: i32, height: i32) -> ObservedRead {
    read.node.extents = Field::Present(Extents {
        x,
        y,
        width,
        height,
    });
    read
}

fn state_of(read: &ObservedRead) -> agent_desktop_core::ElementState {
    state_in(read, &Placement::default())
}

fn state_in(read: &ObservedRead, placement: &Placement) -> agent_desktop_core::ElementState {
    live_state(read, &evidence_of(read), placement).expect("the state projects")
}

fn hidden(read: &ObservedRead) -> bool {
    state_of(read)
        .states
        .iter()
        .any(|token| token == state::HIDDEN)
}

#[test]
fn gtk4_entry_activation_is_refused_without_removing_real_click_verbs_or_bounds() {
    use crate::system::process::toolkit_id::ToolkitId;
    use crate::tree::vocabulary::role_numbers::{ENTRY, TEXT};
    for (role, version, names, clickable) in [
        (ENTRY, "4.14.5", vec!["Activate"], false),
        (TEXT, "4.14.5", vec!["Activate"], false),
        (PASSWORD_TEXT, "4.14.5", vec!["Activate"], false),
        (ENTRY, "3.24", vec!["Activate"], true),
        (ENTRY, "4.14.5", vec!["Activate", "Click"], true),
        (PUSH_BUTTON, "4.14.5", vec!["Activate"], true),
    ] {
        let read = with_extents(read_of(role, "field", &names), 10, 20, 80, 30);
        let placement = Placement {
            toolkit: ToolkitId {
                name: Some("GTK".into()),
                version: Some(version.into()),
            },
            ..Placement::default()
        };
        let live = live_element(&read, &evidence_of(&read), &placement, true).unwrap();
        assert_eq!(
            live.available_actions.iter().any(|a| a == "Click"),
            clickable
        );
        assert_eq!(live.bounds, live_bounds(&read));
    }
}

#[test]
fn visible_without_showing_and_showing_alone_are_not_hidden() {
    let visible = with_states(read_of(PUSH_BUTTON, "b", &[]), &[ENABLED, VISIBLE]);
    assert!(!hidden(&visible));
    let showing_only = with_states(read_of(PUSH_BUTTON, "b", &[]), &[ENABLED, SHOWING]);
    assert!(!hidden(&showing_only));
    let showing = with_states(read_of(PUSH_BUTTON, "b", &[]), &[ENABLED, VISIBLE, SHOWING]);
    assert!(!hidden(&showing));
    let projected = state_of(&showing);
    assert!(state::is_visible(live_bounds(&showing), &projected.states));
}

#[test]
fn a_failed_state_read_is_the_incomplete_answer_and_never_an_empty_state_list() {
    let mut read = read_of(PUSH_BUTTON, "b", &[]);
    read.node.traits.states = Field::Failed("no answer".to_owned());
    let error =
        live_state(&read, &evidence_of(&read), &Placement::default()).expect_err("incomplete");
    assert_eq!(error.code, ErrorCode::AppUnresponsive);
    assert!(error.is_explicitly_retryable());
}

#[test]
fn enabled_comes_from_either_bit_and_disabled_needs_a_successful_read_with_neither() {
    for bits in [&[ENABLED][..], &[SENSITIVE][..]] {
        let read = with_states(read_of(PUSH_BUTTON, "b", &[]), bits);
        let projected = state_of(&read);
        assert_eq!(projected.enabled, Some(true));
        assert!(
            !projected
                .states
                .iter()
                .any(|token| token == state::DISABLED)
        );
        assert_eq!(projected.offscreen, None);
        assert_eq!(projected.hidden, None);
    }
    let neither = with_states(read_of(PUSH_BUTTON, "b", &[]), &[VISIBLE]);
    let projected = state_of(&neither);
    assert_eq!(projected.enabled, Some(false));
    assert!(
        projected
            .states
            .iter()
            .any(|token| token == state::DISABLED)
    );
}

#[test]
fn a_read_only_node_with_neither_enabled_bit_is_enabled() {
    let read = with_states(read_of(PUSH_BUTTON, "b", &[]), &[READ_ONLY, VISIBLE]);
    let projected = state_of(&read);
    assert_eq!(projected.enabled, Some(true));
    assert!(
        !projected
            .states
            .iter()
            .any(|token| token == state::DISABLED)
    );
}

#[test]
fn zero_and_negative_extents_are_values_and_the_sentinel_or_a_missing_read_is_none() {
    let zero = with_extents(read_of(PUSH_BUTTON, "z", &[]), 0, 0, 710, 0);
    assert_eq!(
        live_bounds(&zero),
        Some(Rect {
            x: 0.0,
            y: 0.0,
            width: 710.0,
            height: 0.0
        })
    );
    let negative = with_extents(read_of(PUSH_BUTTON, "n", &[]), -1, -1, -1, -1);
    assert_eq!(
        live_bounds(&negative).map(|rect| (rect.width, rect.height)),
        Some((-1.0, -1.0))
    );
    let sentinel = with_extents(read_of(PUSH_BUTTON, "s", &[]), i32::MIN, i32::MIN, 1, 1);
    assert_eq!(live_bounds(&sentinel), None);
    let mut absent = read_of(PUSH_BUTTON, "a", &[]);
    absent.node.extents = Field::Absent;
    assert_eq!(live_bounds(&absent), None);
    absent.node.extents = Field::Failed("x".to_owned());
    assert_eq!(live_bounds(&absent), None);
}

#[test]
fn a_value_is_read_as_the_node_gives_it_and_a_failed_read_is_incomplete() {
    let mut slider = read_of(SLIDER, "s", &[]);
    slider.value.value = Field::Present("7".to_owned());
    assert_eq!(
        live_value(&evidence_of(&slider)).expect("reads"),
        Some("7".to_owned())
    );
    let plain = read_of(PUSH_BUTTON, "b", &[]);
    assert_eq!(live_value(&evidence_of(&plain)).expect("reads"), None);
    let mut failed = read_of(SLIDER, "s", &[]);
    failed.value.value = Field::Failed("x".to_owned());
    let error = live_value(&evidence_of(&failed)).expect_err("incomplete");
    assert_eq!(error.code, ErrorCode::AppUnresponsive);
}

#[test]
fn a_secure_fields_value_is_withheld_even_when_one_was_read() {
    let mut password = read_of(PASSWORD_TEXT, "p", &[]);
    password.value.value = Field::Present("hunter2".to_owned());
    let evidence = evidence_of(&password);
    assert!(
        evidence
            .states
            .known()
            .is_some_and(|tokens| tokens.iter().any(|token| token == state::SECURE))
    );
    assert_eq!(live_value(&evidence).expect("reads"), None);
    assert_eq!(state_of(&password).value, None);
}

#[test]
fn actions_map_by_the_capability_table_and_a_failed_list_is_incomplete() {
    let button = read_of(PUSH_BUTTON, "b", &["click"]);
    assert_eq!(
        live_actions(&evidence_of(&button)).expect("reads"),
        vec![agent_desktop_core::actions::capability::CLICK.to_owned()]
    );
    let none = read_of(PUSH_BUTTON, "b", &[]);
    assert!(live_actions(&evidence_of(&none)).expect("reads").is_empty());
    let mut failed = read_of(PUSH_BUTTON, "b", &["click"]);
    failed.node.actions = Field::Failed("x".to_owned());
    assert_eq!(
        live_actions(&evidence_of(&failed))
            .expect_err("incomplete")
            .code,
        ErrorCode::AppUnresponsive
    );
}

fn wayland_placement() -> Placement {
    Placement {
        frame_iconified: Some(false),
        frame: Some(Extents {
            x: 0,
            y: 0,
            width: 800,
            height: 600,
        }),
        wayland_unplaced: true,
        ..Placement::default()
    }
}

#[test]
fn a_shown_node_of_a_mapped_wayland_frame_is_on_screen_and_not_hidden_with_no_rectangle() {
    let read = with_states(
        read_of(PUSH_BUTTON, "b", &[]),
        &[VISIBLE, SHOWING, SENSITIVE],
    );
    let projected = state_in(&read, &wayland_placement());
    assert_eq!(projected.offscreen, Some(false));
    assert_eq!(projected.hidden, Some(false));
    assert!(
        !projected
            .states
            .iter()
            .any(|token| token == state::OFFSCREEN)
    );
}

#[test]
fn a_wayland_frame_with_unread_state_does_not_prove_visibility() {
    let read = with_states(
        read_of(PUSH_BUTTON, "b", &[]),
        &[VISIBLE, SHOWING, SENSITIVE],
    );
    let placed = Placement {
        frame: wayland_placement().frame,
        wayland_unplaced: true,
        ..Placement::default()
    };
    let projected = state_in(&read, &placed);
    assert_eq!((projected.offscreen, projected.hidden), (None, None));
}

#[test]
fn the_mapped_wayland_claim_needs_the_wayland_flag_both_state_bits_and_a_live_frame() {
    let shown = with_states(
        read_of(PUSH_BUTTON, "b", &[]),
        &[VISIBLE, SHOWING, SENSITIVE],
    );
    let none = |placement: &Placement| {
        let projected = state_in(&shown, placement);
        (projected.offscreen, projected.hidden)
    };
    assert_eq!(none(&Placement::default()), (None, None));
    let mut iconified = wayland_placement();
    iconified.frame_iconified = Some(true);
    assert_eq!(none(&iconified), (Some(true), None));
    let mut no_frame = wayland_placement();
    no_frame.frame = None;
    assert_eq!(none(&no_frame), (None, None));
    let visible_only = with_states(read_of(PUSH_BUTTON, "b", &[]), &[VISIBLE, SENSITIVE]);
    assert_eq!(
        state_in(&visible_only, &wayland_placement()).offscreen,
        None
    );
}
