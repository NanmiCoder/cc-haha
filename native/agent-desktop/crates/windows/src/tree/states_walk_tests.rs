//! The states these assert reach `LocatorEvidence` through the real walk, not
//! through a direct call to the producer. That is the difference that matters:
//! a producer can be correct while the slot it fills is never threaded, which
//! is exactly the shape the states plumbing had before it was built.

use agent_desktop_core::tree::state;

use crate::tree::properties::PropertyOutcome;
use crate::tree::properties::property_ids::TreeProperty;
use crate::tree::test_support::flag;
use crate::tree::walk::walker_fake::{FakeTree, budget, walk};

fn enabled_true() -> (TreeProperty, PropertyOutcome) {
    flag(TreeProperty::IsEnabled, true)
}

#[test]
fn end_to_end_through_the_walk_reaches_locator_evidence_states() {
    let fake = FakeTree::default()
        .with_children(1, &[2])
        .reading(2, &[flag(TreeProperty::IsEnabled, false)]);

    let outcome = walk(&fake, budget(10));
    let root = outcome
        .tree
        .into_accessibility_tree()
        .expect("a complete walk projects");
    let child = root.children.first().expect("the child was walked");

    assert!(
        child
            .presentation
            .states
            .contains(&state::DISABLED.to_string())
    );
}

#[test]
fn offscreen_on_a_container_does_not_reach_its_children() {
    let fake = FakeTree::default()
        .with_children(1, &[2])
        .reading(1, &[enabled_true(), flag(TreeProperty::IsOffscreen, true)])
        .reading(2, &[enabled_true(), flag(TreeProperty::IsOffscreen, false)]);

    let outcome = walk(&fake, budget(10));
    let root = outcome
        .tree
        .into_accessibility_tree()
        .expect("a complete walk projects");
    let child = root.children.first().expect("the child was walked");

    assert!(
        root.presentation
            .states
            .contains(&state::OFFSCREEN.to_string())
    );
    assert!(
        !child
            .presentation
            .states
            .contains(&state::OFFSCREEN.to_string())
    );
}
