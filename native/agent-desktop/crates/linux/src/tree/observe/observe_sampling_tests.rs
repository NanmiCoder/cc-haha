use super::settle_tests::{request, walk_of, window};
use super::*;
use std::cell::Cell;

#[test]
fn settling_places_only_the_returned_full_payload() {
    let purposes = std::cell::RefCell::new(Vec::new());
    let placements = Cell::new(0);
    let mut walker = |_: &AtspiElement, _: &WalkLimits, _, purpose| {
        purposes.borrow_mut().push(purpose);
        walk_of(2, true)
    };
    let window = window();
    let result = observe_with(
        ObservationRoot::Window(&window),
        &request(5000),
        SettleHost {
            walker: &mut walker,
            is_web_process: &|_| Ok(true),
            stopped: &|_| false,
            pause: &mut |_| {},
            place: &mut |_| {
                placements.set(placements.get() + 1);
                Ok(())
            },
        },
    )
    .unwrap();
    assert!(result.is_complete());
    assert_eq!(placements.get(), 1);
    assert!(
        purposes.borrow().as_slice()
            == [
                super::ReadPurpose::Snapshot,
                super::ReadPurpose::Sampling,
                super::ReadPurpose::Snapshot
            ]
    );
}

#[test]
fn busy_document_samples_cannot_certify_a_completed_tree() {
    let calls = Cell::new(0);
    let window = window();
    let mut walker = |_: &AtspiElement, _: &WalkLimits, _, _| {
        calls.set(calls.get() + 1);
        let mut walk = walk_of(2, true)?;
        if calls.get() <= 3 {
            walk.root.payload.node.traits.states =
                crate::tree::Field::Present(crate::tree::live::test_support::words(&[
                    crate::tree::vocabulary::state_bits::BUSY,
                ]));
        }
        Ok(walk)
    };
    let result = observe_with(
        ObservationRoot::Window(&window),
        &request(5000),
        SettleHost {
            walker: &mut walker,
            is_web_process: &|_| Ok(true),
            stopped: &|_| false,
            pause: &mut |_| {},
            place: &mut |_| Ok(()),
        },
    )
    .unwrap();
    assert!(result.is_complete());
    assert_eq!(
        calls.get(),
        6,
        "three non-busy samples must corroborate readiness"
    );
}

#[test]
fn an_interrupted_narrow_sample_returns_the_full_payload_as_incomplete() {
    let calls = Cell::new(0);
    let window = window();
    let mut walker = |_: &AtspiElement, _: &WalkLimits, _, _| {
        calls.set(calls.get() + 1);
        let mut walk = walk_of(2, true)?;
        if calls.get() == 2 {
            walk.complete = false;
            walk.root.payload.node.properties.name =
                super::super::Field::Present("narrow only".into());
        }
        Ok(walk)
    };
    let tree = observe_with(
        ObservationRoot::Window(&window),
        &request(5000),
        SettleHost {
            walker: &mut walker,
            is_web_process: &|_| Ok(true),
            stopped: &|_| false,
            pause: &mut |_| {},
            place: &mut |_| Ok(()),
        },
    )
    .unwrap();
    let (root, complete, _) = tree.into_accessibility_tree_partial().unwrap();
    assert!(!complete);
    assert_eq!(root.identity.name.as_deref(), Some("b"));
}
