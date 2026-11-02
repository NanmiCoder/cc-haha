use super::*;
use crate::tree::element::UIAElement;
use crate::tree::fixture::{HostedFixture, ensure_test_apartment};
use crate::tree::walk::walker_fake::{deadline, ref_entry, scan_subtree};
use agent_desktop_core::{
    ErrorCode, IdentifierEvidence, LocatorEvidence, LocatorField, LocatorRefEvidence,
    NodeDescriptor, ProcessId, Rect, RefEntry,
};
use std::ops::ControlFlow;

fn blank_entry_with_path(fixture: &HostedFixture, path: Vec<usize>) -> RefEntry {
    let deadline = deadline();
    let root = crate::tree::automation::root_from_hwnd(fixture.handle(), deadline)
        .expect("a fixture root");
    let source =
        crate::tree::walk::walker_source::UiaTreeSource::for_root(&root).expect("a source");
    let prepared = source.prepare_root(&root).expect("a prepared root");
    let budget = crate::tree::walk::walker::WalkBudget::new(10, deadline);
    let found = walk_first_secure(&source, &prepared, &budget)
        .expect("the fixture walk succeeds")
        .expect("a secure element exists");
    let stored_path = found.path;
    let evidence = found.evidence;
    let rect = evidence
        .ref_evidence
        .bounds
        .known()
        .expect("positive-area bounds");
    let hash = rect.bounds_hash().expect("a positive-area hash");
    let token =
        crate::system::process_identity::token_for_pid(ProcessId::new(fixture.process_id()))
            .unwrap()
            .expect("a live fixture token");
    let chosen_path = if path.is_empty() { stored_path } else { path };
    let mut entry = ref_entry(&evidence.role.known().cloned().unwrap_or_default());
    entry.process = agent_desktop_core::RefProcess {
        pid: ProcessId::new(fixture.process_id()),
        process_instance: Some(token),
    };
    entry.geometry = agent_desktop_core::RefGeometry {
        bounds_space: None,
        bounds: Some(*rect),
        bounds_hash: Some(hash),
    };
    entry.source.source_app = Some("fixture.exe".into());
    entry.source.source_window_id = Some(format!("w-{}", fixture.handle()));
    entry.scope.path_is_absolute = true;
    entry.scope.path = chosen_path.into();
    entry
}

struct FoundSecure {
    path: Vec<usize>,
    _properties: crate::tree::properties::ElementProperties,
    evidence: agent_desktop_core::LocatorEvidence,
    _failed: u64,
}

fn walk_first_secure(
    source: &crate::tree::walk::walker_source::UiaTreeSource,
    element: &UIAElement,
    budget: &crate::tree::walk::walker::WalkBudget,
) -> Result<Option<FoundSecure>, AdapterError> {
    scan_subtree(
        source,
        element,
        budget,
        10,
        &mut |prefix, properties, evidence, failed| {
            if properties.is_secure() {
                ControlFlow::Break(FoundSecure {
                    path: prefix.to_vec(),
                    _properties: properties,
                    evidence,
                    _failed: failed,
                })
            } else {
                ControlFlow::Continue(())
            }
        },
    )
}

/// A stored anchor path that is exact on the unchanged fixture resolves -
/// the hydration happy path.
#[test]
fn an_exact_anchor_path_resolves_on_the_unchanged_fixture() {
    ensure_test_apartment();
    let fixture = HostedFixture::spawn().expect("a fixture host starts");
    let entry = blank_entry_with_path(&fixture, Vec::new());
    let handle = resolve_locator_anchor(&entry, deadline())
        .expect("the exact anchor path resolves the secure element");
    assert!(handle.downcast_ref::<UIAElement>().is_some());
}

/// A path that points at a sibling beyond the target settles stale in a
/// single attempt - the anchor never resolves a neighbour, and never
/// replays a landing that was never eligible to resolve.
#[test]
fn a_wrong_child_index_settles_stale_never_a_neighbour() {
    ensure_test_apartment();
    let fixture = HostedFixture::spawn().expect("a fixture host starts");
    let entry = blank_entry_with_path(&fixture, vec![999]);
    let deadline = deadline();
    let attempts = std::cell::Cell::new(0);
    let result = crate::tree::resolve::retry_incomplete_until(deadline, || {
        attempts.set(attempts.get() + 1);
        resolve_locator_anchor_once(&entry, deadline)
    });
    let error = match result {
        Err(error) => error,
        Ok(_) => panic!("a path that lands nowhere settles, it does not resolve"),
    };
    assert_eq!(error.code, ErrorCode::StaleRef);
    assert_eq!(
        attempts.get(),
        1,
        "a path that lands nowhere must settle on the first attempt, never retried"
    );
}

/// A role-refuted landing settles stale: the stored ref records the secure
/// element's role, the path lands on the fixture's button, and the anchor
/// refuses - the path is a locator, never an identity by itself.
#[test]
fn a_role_refuted_landing_settles_stale() {
    ensure_test_apartment();
    let fixture = HostedFixture::spawn().expect("a fixture host starts");
    let entry = blank_entry_with_path(&fixture, vec![0]);
    let deadline = deadline();
    let root = crate::tree::automation::root_from_hwnd(fixture.handle(), deadline)
        .expect("a fixture root");
    let source =
        crate::tree::walk::walker_source::UiaTreeSource::for_root(&root).expect("a source");
    let prepared = source.prepare_root(&root).expect("a prepared root");
    let landing = crate::tree::resolve::resolve_search::descent::descend_path(
        &source,
        &prepared,
        &entry.scope.path,
        &crate::tree::walk::walker::WalkBudget::new(10, deadline),
        &ANCHOR_DESCENT,
    )
    .expect("the stored path descends");
    let landed = landing.element.expect(
        "the stored path must land on a live element for the role guard to be what refuses it",
    );
    let (_, evidence, _) = source.evidence(&landed);
    assert!(
        evidence
            .role
            .known()
            .is_some_and(|role| role != &entry.identity.role),
        "the landing must carry a known role different from the stored ref's"
    );

    let error = match resolve_locator_anchor(&entry, deadline) {
        Err(error) => error,
        Ok(_) => panic!("a role-refuted landing settles stale, it does not resolve"),
    };
    assert_eq!(error.code, ErrorCode::StaleRef);
}

/// `Rect::bounds_hash` answers `Some` for a zero-extent rectangle - it only
/// rejects an invalid one - so an id-less, text-less entry whose stored hash
/// comes from a zero-extent rectangle is not eligible for the geometry tier
/// at all (`provisional_geometry_candidate` requires positive area). The
/// eligibility gate must reject it before the path is even walked, settling
/// in one attempt instead of landing the path every retry and burning the
/// shared find deadline on a landing that could never verify.
#[test]
fn a_zero_extent_id_less_entry_settles_on_the_first_attempt() {
    ensure_test_apartment();
    let fixture = HostedFixture::spawn().expect("a fixture host starts");
    let mut entry = blank_entry_with_path(&fixture, Vec::new());
    let zero_extent = Rect {
        x: 0.0,
        y: 0.0,
        width: 0.0,
        height: 0.0,
    };
    let hash = zero_extent
        .bounds_hash()
        .expect("a zero-extent rect is still a valid rect, and still hashes");
    entry.geometry = agent_desktop_core::RefGeometry {
        bounds_space: None,
        bounds: Some(zero_extent),
        bounds_hash: Some(hash),
    };

    let deadline = deadline();
    let attempts = std::cell::Cell::new(0);
    let result = crate::tree::resolve::retry_incomplete_until(deadline, || {
        attempts.set(attempts.get() + 1);
        resolve_locator_anchor_once(&entry, deadline)
    });

    let error = match result {
        Err(error) => error,
        Ok(_) => panic!("a zero-extent, id-less anchor must never resolve"),
    };
    assert_eq!(error.code, ErrorCode::StaleRef);
    assert_eq!(
        attempts.get(),
        1,
        "a zero-extent id-less entry must settle in one attempt, not burn the deadline retrying"
    );
}

fn locator_entry(role: &str, positive_area_hash: Option<Rect>) -> RefEntry {
    let (bounds, bounds_hash) = match positive_area_hash {
        Some(rect) => (Some(rect), rect.bounds_hash()),
        None => (None, None),
    };
    let mut entry = ref_entry(role);
    entry.geometry = agent_desktop_core::RefGeometry {
        bounds_space: None,
        bounds,
        bounds_hash,
    };
    entry.scope.path_is_absolute = true;
    entry
}

fn locator_evidence(role: &str, bounds: LocatorField<Rect>) -> LocatorEvidence {
    LocatorEvidence {
        role: LocatorField::Known(role.to_string()),
        name: LocatorField::Absent,
        value: LocatorField::Absent,
        description: LocatorField::Absent,
        identifiers: IdentifierEvidence::absent(),
        states: LocatorField::Absent,
        ref_evidence: LocatorRefEvidence {
            window_bounds: LocatorField::Absent,
            bounds,
            available_actions: LocatorField::Absent,
            descriptors: NodeDescriptor::default(),
        },
    }
}

/// A geometry-eligible entry whose live bounds were read successfully but
/// disagree with the stored hash has a definitive answer - the comparison
/// ran and failed - and must settle stale rather than retry.
#[test]
fn a_read_geometry_mismatch_settles_stale() {
    let stored = Rect {
        x: 0.0,
        y: 0.0,
        width: 10.0,
        height: 10.0,
    };
    let live = Rect {
        x: 50.0,
        y: 50.0,
        width: 10.0,
        height: 10.0,
    };
    let entry = locator_entry("button", Some(stored));
    let evidence = locator_evidence("button", LocatorField::Known(live));

    match anchor_geometry_verdict(&entry, &evidence) {
        AnchorGeometryVerdict::SettleStale => {}
        AnchorGeometryVerdict::Promote => panic!("a disagreeing hash must never promote"),
        AnchorGeometryVerdict::Retry => {
            panic!("a read-and-disagreeing hash is a definitive answer, not a transient read")
        }
    }
}

/// The same geometry-eligible entry, but this attempt's live bounds read
/// came back unreadable rather than disagreeing. That is the genuinely
/// transient case `identity_unknown_error` stays reserved for, and must
/// still retry.
#[test]
fn an_unread_live_geometry_still_retries() {
    let stored = Rect {
        x: 0.0,
        y: 0.0,
        width: 10.0,
        height: 10.0,
    };
    let entry = locator_entry("button", Some(stored));
    let evidence = locator_evidence("button", LocatorField::Unknown);

    match anchor_geometry_verdict(&entry, &evidence) {
        AnchorGeometryVerdict::Retry => {}
        AnchorGeometryVerdict::Promote => panic!("an unread bounds field must never promote"),
        AnchorGeometryVerdict::SettleStale => {
            panic!("an unread bounds field is a transient read, not a settled mismatch")
        }
    }
}

/// Pins the fix for a tri-state defect where a failed role read was treated
/// the same as a settled role mismatch. A role read that comes back
/// `Unknown` must stay retryable, never a settled `STALE_REF`.
#[test]
fn a_role_read_that_comes_back_unknown_is_retryable_not_settled() {
    let entry = locator_entry("button", None);
    let evidence = locator_evidence("button", LocatorField::Absent);
    let mut unknown_role_evidence = evidence;
    unknown_role_evidence.role = LocatorField::Unknown;

    let error = match anchor_role_verdict(&entry, &unknown_role_evidence) {
        Err(error) => error,
        Ok(()) => panic!("an unknown role must never verify as a match"),
    };
    assert_eq!(error.code, ErrorCode::Timeout);
    assert_eq!(
        error.disposition,
        agent_desktop_core::DeliverySemantics::not_delivered()
    );
    assert!(error.is_transient_incomplete_read());
    assert_eq!(
        error
            .details
            .as_ref()
            .and_then(|details| details.get("retryable"))
            .and_then(serde_json::Value::as_bool),
        Some(true),
        "a role read that failed must be stamped explicitly retryable"
    );
}

/// The role guard's other settled branch, for contrast: a role that was
/// read successfully but disagrees with the stored ref settles stale.
#[test]
fn a_known_but_mismatched_role_settles_stale() {
    let entry = locator_entry("button", None);
    let evidence = locator_evidence("checkbox", LocatorField::Absent);

    let error = match anchor_role_verdict(&entry, &evidence) {
        Err(error) => error,
        Ok(()) => panic!("a mismatched role must never verify as a match"),
    };
    assert_eq!(error.code, ErrorCode::StaleRef);
}
