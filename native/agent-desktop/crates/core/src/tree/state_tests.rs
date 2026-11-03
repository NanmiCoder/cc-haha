use super::*;
use crate::Rect;

#[test]
fn vocabulary_contains_seventeen_tokens() {
    assert_eq!(STATE_VOCABULARY.len(), 17);
}

#[test]
fn hidden_element_is_not_visible() {
    let bounds = Some(Rect {
        x: 0.0,
        y: 0.0,
        width: 10.0,
        height: 10.0,
    });
    assert!(!is_visible(bounds, &[HIDDEN.to_string()]));
}

#[test]
fn zero_sized_bounds_are_not_visible() {
    let bounds = Some(Rect {
        x: 0.0,
        y: 0.0,
        width: 0.0,
        height: 10.0,
    });
    assert!(!is_visible(bounds, &[]));
}

#[test]
fn offscreen_element_is_not_visible() {
    let bounds = Some(Rect {
        x: 0.0,
        y: 0.0,
        width: 10.0,
        height: 10.0,
    });
    assert!(!is_visible(bounds, &[OFFSCREEN.to_string()]));
}

#[test]
fn visible_element_with_live_evidence() {
    let bounds = Some(Rect {
        x: 0.0,
        y: 0.0,
        width: 10.0,
        height: 10.0,
    });
    assert!(is_visible(bounds, &[]));
}

/// Proves `assert_states_in_vocabulary` is a real membership check and not a
/// tautology: fed a token that is not derived from any `state::` constant,
/// it must panic. Without this, a future refactor could gut the assertion
/// into a no-op and every other conformance test built on top of it would
/// keep passing silently.
#[test]
#[should_panic(expected = "is not in STATE_VOCABULARY")]
fn assert_states_in_vocabulary_panics_on_bogus_token() {
    assert_states_in_vocabulary(&["zzz_not_a_real_state_token".to_string()]);
}
