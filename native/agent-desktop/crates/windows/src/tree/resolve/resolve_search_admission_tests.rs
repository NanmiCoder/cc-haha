use super::*;
use crate::tree::resolve::resolve_match::candidate_outcome;
use agent_desktop_core::{IdentifierEvidence, LocatorField, NodeDescriptor, Rect};

/// A role whose value is mutable, which is what makes `candidate_outcome`
/// answer `Incomplete` for a blank ref on every attempt rather than only when
/// a read happens to fail. That is the entry into the promotion arm.
const PROMOTABLE_ROLE: &str = "textfield";

/// A role whose value is stable, so a stored name settles the match outright
/// and the control arms below are decided by identity rather than geometry.
const NAMED_ROLE: &str = "button";

fn rect(width: f64, height: f64) -> Rect {
    Rect {
        x: 12.0,
        y: 24.0,
        width,
        height,
    }
}

fn stored(role: &str, name: Option<&str>, bounds: Option<Rect>) -> RefEntry {
    let mut entry = crate::tree::walk::walker_fake::ref_entry(role);
    entry.identity.name = name.map(str::to_string);
    entry.geometry = agent_desktop_core::RefGeometry {
        bounds_space: None,
        bounds,
        bounds_hash: bounds.and_then(|rect| rect.bounds_hash()),
    };
    entry.scope.path_is_absolute = true;
    entry
}

fn live(
    role: LocatorField<String>,
    name: LocatorField<String>,
    bounds: LocatorField<Rect>,
) -> LocatorEvidence {
    LocatorEvidence {
        role,
        name,
        value: LocatorField::Absent,
        description: LocatorField::Absent,
        identifiers: IdentifierEvidence::absent(),
        states: LocatorField::Absent,
        ref_evidence: agent_desktop_core::LocatorRefEvidence {
            window_bounds: LocatorField::Absent,
            bounds,
            available_actions: LocatorField::Absent,
            descriptors: NodeDescriptor::default(),
        },
    }
}

fn role_known(role: &str) -> LocatorField<String> {
    LocatorField::Known(role.to_string())
}

/// The promotion arm itself, on the shape it exists for: a ref with no text
/// identity whose role carries a mutable value can never be settled by text,
/// so an `Incomplete` identity corroborated by a positive-area geometry match
/// is collected as a candidate rather than withheld as an unread region. Take
/// this arm away and the class has no tier left at all.
#[test]
fn an_unsettleable_identity_is_collected_when_positive_area_geometry_agrees() {
    let bounds = rect(40.0, 20.0);
    let entry = stored(PROMOTABLE_ROLE, None, Some(bounds));
    let evidence = live(
        role_known(PROMOTABLE_ROLE),
        LocatorField::Absent,
        LocatorField::Known(bounds),
    );

    assert_eq!(
        candidate_outcome(&entry, &evidence),
        CandidateOutcome::Incomplete,
        "the promotion arm is only reachable through an incomplete identity"
    );
    assert_eq!(admit_node(&entry, &evidence), NodeAdmission::Collect);
}

/// The other half of the same rule (A17-7): offscreen and virtualized
/// elements collapse to shared zero-extent bounds, so a zero-extent stored
/// rectangle identifies nothing even when its hash agrees exactly. The stored
/// and live hashes are asserted equal here, so the zero extent is the only
/// thing left that can refuse the promotion.
#[test]
fn a_zero_extent_stored_rectangle_never_promotes_even_on_an_exact_hash_agreement() {
    let flattened = rect(0.0, 0.0);
    let entry = stored(PROMOTABLE_ROLE, None, Some(flattened));
    let evidence = live(
        role_known(PROMOTABLE_ROLE),
        LocatorField::Absent,
        LocatorField::Known(flattened),
    );

    assert!(
        entry.geometry.bounds_hash.is_some(),
        "a zero-extent rectangle still hashes, so the hash alone cannot be the gate"
    );
    assert_eq!(
        bounds_hash_of(&evidence),
        entry.geometry.bounds_hash,
        "the live and stored hashes agree, so only the zero extent can refuse this"
    );
    assert_eq!(admit_node(&entry, &evidence), NodeAdmission::Unread);
}

/// An unpromoted incomplete is withheld, never refuted. Geometry that
/// disagrees - or that could not be read - says nothing about a candidate
/// whose identity was never settleable, so the region stays unread and the
/// resolution retries rather than counting this node as ruled out.
#[test]
fn an_incomplete_identity_the_geometry_does_not_corroborate_stays_unread() {
    let entry = stored(PROMOTABLE_ROLE, None, Some(rect(40.0, 20.0)));

    let elsewhere = live(
        role_known(PROMOTABLE_ROLE),
        LocatorField::Absent,
        LocatorField::Known(rect(80.0, 20.0)),
    );
    assert_eq!(admit_node(&entry, &elsewhere), NodeAdmission::Unread);

    let unreadable = live(
        role_known(PROMOTABLE_ROLE),
        LocatorField::Absent,
        LocatorField::Unknown,
    );
    assert_eq!(admit_node(&entry, &unreadable), NodeAdmission::Unread);
}

/// The two settled identity arms, so the promotion above is not the only
/// behaviour this decision has: a matching identity is collected and a
/// contradicted one is rejected outright, neither of them withheld.
#[test]
fn a_settled_identity_is_collected_or_rejected_and_never_withheld() {
    let entry = stored(NAMED_ROLE, Some("Save"), None);

    let same = live(
        role_known(NAMED_ROLE),
        LocatorField::Known("Save".to_string()),
        LocatorField::Absent,
    );
    assert_eq!(admit_node(&entry, &same), NodeAdmission::Collect);

    let other = live(
        role_known(NAMED_ROLE),
        LocatorField::Known("Cancel".to_string()),
        LocatorField::Absent,
    );
    assert_eq!(admit_node(&entry, &other), NodeAdmission::Reject);
}

/// The role gate, both directions. A role that read back as something else is
/// a real refusal, while a role that could not be read at all leaves the
/// region unread - collapsing the second into the first would settle
/// `STALE_REF` off a tree the search never managed to classify.
#[test]
fn a_different_role_is_rejected_but_an_unreadable_one_is_only_unread() {
    let entry = stored(NAMED_ROLE, Some("Save"), None);
    let name = LocatorField::Known("Save".to_string());

    let different = live(
        role_known(PROMOTABLE_ROLE),
        name.clone(),
        LocatorField::Absent,
    );
    assert_eq!(admit_node(&entry, &different), NodeAdmission::Reject);

    let absent = live(LocatorField::Absent, name.clone(), LocatorField::Absent);
    assert_eq!(admit_node(&entry, &absent), NodeAdmission::Reject);

    let unreadable = live(LocatorField::Unknown, name, LocatorField::Absent);
    assert_eq!(admit_node(&entry, &unreadable), NodeAdmission::Unread);
}
