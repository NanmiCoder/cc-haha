//! What a failed child enumeration reports, split from `walker_tests.rs`
//! (at the per-file line cap): the structured error's shape, and the count
//! that travels when the reporting cap drops later faults.

use crate::tree::walk::walker_fake::{FakeTree, budget, walk};

/// The enumeration error carries shape and nothing else: no value, name, class
/// name, window title, or provider description may reach a message that
/// `ref_action.rs` clones into session trace segments.
#[test]
fn an_enumeration_error_carries_shape_only() {
    let fake = FakeTree::default()
        .with_children(1, &[2])
        .faulting_on_first_child(2);

    let outcome = walk(&fake, budget(10));
    let failure = outcome.failures.first().expect("a structured failure");
    let details = failure.details.as_ref().expect("structured details");

    assert_eq!(details["kind"], "child_enumeration_failed");
    let keys: Vec<&String> = details
        .as_object()
        .expect("a details object")
        .keys()
        .collect();
    assert_eq!(keys, ["axis", "child_index", "kind", "raw_depth"]);
    assert_eq!(
        details["axis"], "first_child",
        "the axis names which enumeration call failed; a key-presence check accepts either name"
    );
    assert_eq!(details["child_index"], 0);
    assert!(failure.message.contains("UI Automation"));
    assert!(
        failure
            .platform_detail
            .as_ref()
            .expect("a platform detail")
            .contains("0x80004005")
    );
}

/// The failure cap keeps one pathological target from flooding a trace
/// segment, but a consumer that sees the cap and no count would read a
/// systemic failure as a local one. The count travels even though the dropped
/// errors do not.
#[test]
fn faults_beyond_the_reporting_cap_are_counted_rather_than_vanishing() {
    let children: Vec<i32> = (2..=40).collect();
    let mut fake = FakeTree::default().with_children(1, &children);
    for child in &children {
        fake = fake.faulting_on_first_child(*child);
    }

    let outcome = walk(&fake, budget(10));

    assert!(!outcome.tree.is_complete());
    let suppressed = outcome
        .failures
        .last()
        .and_then(|error| error.details.as_ref())
        .and_then(|details| details.get("suppressed_failures"))
        .and_then(serde_json::Value::as_u64)
        .unwrap_or_default();
    assert!(
        suppressed > 0,
        "a walk that dropped faults must say how many"
    );
    assert_eq!(
        outcome.stats.reads.health.cannot_complete,
        suppressed + outcome.failures.len() as u64,
        "the counted total must account for every fault, reported or not"
    );
}
