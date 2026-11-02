use super::*;
use crate::tree::AXElement;
use crate::tree::resolve::resolve_classify::classify_candidates;
use crate::tree::resolve::resolve_roots::{
    require_unique_window_number_match, source_scope_verified, source_window_number,
    source_window_scope_required,
};
use crate::tree::resolve::resolve_search::{
    find_entry_by_path, incomplete_traversal_error, match_native_or_text_identity,
    native_identifier_reused_by_different_role, walk_finite_path,
};
use agent_desktop_core::{
    RefCapabilities, RefEntryIdentity, RefGeometry, RefProcess, RefScope, RefSource,
    SnapshotSurface,
};

pub(super) fn entry(
    bounds_hash: Option<u64>,
    source_window_id: Option<&str>,
    source_window_title: Option<&str>,
    root_ref: Option<&str>,
) -> RefEntry {
    RefEntry {
        process: RefProcess {
            pid: agent_desktop_core::ProcessId::new(1),
            process_instance: Some("test-instance".into()),
        },
        identity: RefEntryIdentity {
            retained_object: None,
            role: "cell".into(),
            name: Some("Investors".into()),
            value: None,
            description: None,
            native_id: None,
        },
        geometry: RefGeometry {
            bounds_space: None,
            bounds: None,
            bounds_hash,
        },
        capabilities: RefCapabilities {
            states: vec![],
            available_actions: vec![],
        },
        source: RefSource {
            source_app: None,
            source_window_id: source_window_id.map(String::from),
            source_window_title: source_window_title.map(String::from),
            source_window_bounds_hash: None,
            source_surface: SnapshotSurface::Window,
        },
        scope: RefScope {
            root_ref: root_ref.map(String::from),
            path_is_absolute: false,
            path: smallvec::smallvec![0, 1],
        },
    }
}

#[test]
fn path_fast_path_requires_a_hard_window_scope() {
    assert!(!can_use_path_fast_path(&entry(None, None, None, None)));
    assert!(can_use_path_fast_path(&entry(
        None,
        Some("w-10"),
        None,
        None
    )));
    assert!(can_use_path_fast_path(&entry(
        None,
        None,
        Some("Documents"),
        None
    )));
    let mut menu = entry(Some(42), Some("w-10"), None, None);
    menu.source.source_surface = SnapshotSurface::Menu;
    assert!(can_use_path_fast_path(&menu));
}

#[test]
fn locator_anchor_path_requires_scope_and_identity_or_geometry() {
    let mut unscoped = entry(Some(42), None, None, None);
    assert!(!can_use_locator_anchor_path(&unscoped));

    unscoped.source.source_window_id = Some("w-10".into());
    assert!(can_use_locator_anchor_path(&unscoped));

    unscoped.geometry.bounds_hash = None;
    unscoped.identity.name = None;
    assert!(!can_use_locator_anchor_path(&unscoped));
}

#[test]
fn drill_down_path_must_be_absolute() {
    assert!(!can_use_path_fast_path(&entry(
        Some(42),
        Some("w-10"),
        None,
        Some("@e1")
    )));
    let mut absolute = entry(Some(42), Some("w-10"), None, Some("@e1"));
    absolute.scope.path_is_absolute = true;
    assert!(can_use_path_fast_path(&absolute));
}

#[test]
fn broad_search_requires_bounds_or_stable_identity() {
    let mut blank = entry(None, None, None, None);
    blank.identity.name = None;

    assert!(!can_use_broad_search(&blank));
    blank.identity.native_id = Some(agent_desktop_core::ElementIdentifier {
        kind: agent_desktop_core::IdentifierKind::AxDomIdentifier,
        value: "dom-id".into(),
    });
    assert!(can_use_broad_search(&blank));
    blank.identity.native_id = None;
    blank.identity.description = Some("Insert Text Box".into());
    assert!(can_use_broad_search(&blank));
}

#[test]
fn source_window_scope_rejects_malformed_ids_instead_of_broadening() {
    let malformed = entry(Some(42), Some("not-a-window"), None, None);

    assert!(source_window_scope_required(&malformed));
    assert_eq!(source_window_number(&malformed), None);
}

#[test]
fn source_window_number_parses_only_canonical_ids() {
    assert_eq!(
        source_window_number(&entry(None, Some("w-42"), None, None)),
        Some(42)
    );
    assert_eq!(
        source_window_number(&entry(None, Some("42"), None, None)),
        None
    );
    assert_eq!(
        source_window_number(&entry(None, Some("w-0"), None, None)),
        None
    );
    assert_eq!(
        source_window_number(&entry(None, Some("w--1"), None, None)),
        None
    );
}

#[test]
fn duplicate_ax_window_bridge_matches_are_ambiguous() {
    let error = require_unique_window_number_match(2, 42).unwrap_err();

    assert_eq!(error.code, ErrorCode::AmbiguousTarget);
    assert_eq!(error.details.unwrap()["candidate_count"], 2);
}

#[test]
fn mutable_title_scope_never_claims_exact_verification() {
    assert!(!source_scope_verified(None, true));
    assert!(!source_scope_verified(Some("w-42"), false));
    assert!(source_scope_verified(Some("w-42"), true));
}

#[test]
fn strict_resolution_requires_the_exact_process_instance() {
    let pid = i32::try_from(std::process::id()).expect("test pid fits macOS pid_t");
    let token = crate::system::process::process_identity::token_for_pid(pid)
        .unwrap()
        .expect("current process identity");
    let mut stored = entry(None, None, None, None);
    stored.process.pid = agent_desktop_core::ProcessId::try_from(pid).unwrap();
    stored.process.process_instance = Some(token.clone());

    assert!(verify_process_instance(&stored).is_ok());

    stored.process.process_instance = None;
    assert_eq!(
        verify_process_instance(&stored).unwrap_err().code,
        ErrorCode::StaleRef
    );

    stored.process.process_instance = Some(token);
    stored.process.pid = agent_desktop_core::ProcessId::try_from(i32::MAX).unwrap();
    assert_eq!(
        verify_process_instance(&stored).unwrap_err().code,
        ErrorCode::StaleRef
    );
}

#[test]
fn only_explicitly_retryable_incomplete_errors_retry() {
    let retryable = incomplete_traversal_error("children", 3);
    assert!(is_retryable_resolution_error(&retryable));
    assert!(!is_retryable_resolution_error(
        &AdapterError::element_not_found("element")
    ));
    assert!(!is_retryable_resolution_error(
        &AdapterError::permission_denied()
    ));
}

#[test]
fn cannot_complete_retry_can_recover_before_one_deadline() {
    let attempts = std::cell::Cell::new(0);
    let deadline = Instant::now() + Duration::from_secs(5);

    let result = retry_incomplete_until(deadline, || {
        attempts.set(attempts.get() + 1);
        if attempts.get() == 1 {
            Err(incomplete_traversal_error("children", 1))
        } else {
            Ok(7_u8)
        }
    });

    assert_eq!(result.unwrap(), 7);
    assert_eq!(attempts.get(), 2);
}

#[test]
fn incomplete_traversal_is_never_element_not_found() {
    let error = incomplete_traversal_error("depth_limit", 50);

    assert_eq!(error.code, ErrorCode::AppUnresponsive);
    assert_eq!(error.details.unwrap()["complete"], false);
}

#[test]
fn expired_deadline_fails_before_path_reads() {
    let mut context = ResolveReadContext::new(Instant::now());
    let error = find_entry_by_path(
        &[],
        &entry(Some(42), Some("w-42"), None, None),
        true,
        &mut context,
    )
    .err()
    .expect("expired path resolution must fail");

    assert_eq!(error.code, ErrorCode::Timeout);
}

#[test]
fn finite_path_walk_allows_reused_native_handle_identity() {
    let calls = std::cell::Cell::new(0);
    let result = walk_finite_path(7_u8, &[0, 0, 0], |handle, _| {
        calls.set(calls.get() + 1);
        Ok(Some(handle))
    })
    .unwrap();

    assert_eq!(result, Some(7));
    assert_eq!(calls.get(), 3);
}

#[test]
fn preserved_native_path_replays_nested_target_in_one_read_per_level() {
    let reads = std::cell::RefCell::new(Vec::new());
    let result = walk_finite_path(0_u8, &[2, 0], |parent, index| {
        reads.borrow_mut().push(index);
        Ok(match (parent, index) {
            (0, 2) => Some(20),
            (20, 0) => Some(99),
            _ => None,
        })
    })
    .unwrap();

    assert_eq!(result, Some(99));
    assert_eq!(reads.into_inner(), [2, 0]);
}

#[test]
fn ambiguity_reports_bounded_candidate_summaries() {
    let candidates = (0..11).map(|_| AXElement(std::ptr::null_mut())).collect();
    let error = classify_candidates(
        candidates,
        &entry(None, Some("w-42"), None, None),
        true,
        Instant::now() + Duration::from_secs(1),
    )
    .err()
    .expect("duplicate candidates must be ambiguous");

    assert_eq!(error.code, ErrorCode::AmbiguousTarget);
    let details = error.details.unwrap();
    assert_eq!(details["candidate_count"], 11);
    assert_eq!(details["candidate_summaries_truncated"], true);
    assert_eq!(details["candidates"].as_array().unwrap().len(), 10);
}

#[test]
fn unique_scoped_candidate_resolves_even_after_bounds_move() {
    let handle = classify_candidates(
        vec![AXElement(std::ptr::null_mut())],
        &entry(Some(42), Some("w-42"), None, None),
        true,
        Instant::now() + Duration::from_secs(1),
    );

    assert!(handle.is_ok());
}

#[test]
fn scoped_role_only_candidate_does_not_bypass_bounds_verification() {
    let mut weak = entry(None, Some("w-42"), None, None);
    weak.identity.name = None;

    let error = classify_candidates(
        vec![AXElement(std::ptr::null_mut())],
        &weak,
        true,
        Instant::now() + Duration::from_secs(1),
    )
    .err()
    .expect("window scope alone must not identify a role-only candidate");

    assert_eq!(error.code, ErrorCode::ElementNotFound);
}

#[test]
fn authoritatively_absent_native_identifier_is_a_definitive_mismatch() {
    use agent_desktop_core::{
        IdentifierEvidence, LocatorEvidence, LocatorField, LocatorRefEvidence,
    };

    let mut stored = entry(Some(42), Some("w-42"), None, None);
    stored.identity.native_id = Some(agent_desktop_core::ElementIdentifier {
        kind: agent_desktop_core::IdentifierKind::AxIdentifier,
        value: "stable-id".into(),
    });
    let live = LocatorEvidence {
        role: LocatorField::Known(stored.identity.role.clone()),
        name: LocatorField::Known("Investors".into()),
        description: LocatorField::Absent,
        value: LocatorField::Absent,
        identifiers: IdentifierEvidence::absent(),
        states: LocatorField::Absent,
        ref_evidence: LocatorRefEvidence {
            window_bounds: LocatorField::Absent,
            bounds: LocatorField::Absent,
            available_actions: LocatorField::Absent,
            descriptors: Default::default(),
        },
    };

    assert_eq!(
        match_native_or_text_identity(&stored, &live),
        agent_desktop_core::IdentityMatch::NoMatch
    );
}

#[test]
fn native_identifier_reuse_by_a_different_role_is_definitively_stale() {
    use agent_desktop_core::{
        ElementIdentifier, IdentifierEvidence, IdentifierKind, LocatorEvidence, LocatorField,
        LocatorRefEvidence,
    };

    let mut stored = entry(None, Some("w-42"), None, None);
    let identifier = ElementIdentifier {
        kind: IdentifierKind::AxDomIdentifier,
        value: "compose".into(),
    };
    stored.identity.native_id = Some(identifier.clone());
    let live = LocatorEvidence {
        role: LocatorField::Known("textfield".into()),
        name: LocatorField::Absent,
        description: LocatorField::Absent,
        value: LocatorField::Absent,
        identifiers: IdentifierEvidence::typed([identifier], Some(0), true),
        states: LocatorField::Absent,
        ref_evidence: LocatorRefEvidence {
            window_bounds: LocatorField::Absent,
            bounds: LocatorField::Absent,
            available_actions: LocatorField::Absent,
            descriptors: Default::default(),
        },
    };

    assert!(native_identifier_reused_by_different_role(&stored, &live));
}

#[test]
fn complete_absence_remains_retryable_for_renderer_detach_and_reattach() {
    let cause = AdapterError::element_not_found("element");
    let error = stale_ref_error(&entry(None, Some("w-42"), None, None), &cause);

    assert_eq!(error.code, ErrorCode::StaleRef);
    assert_eq!(error.details.unwrap()["retryable"], true);
}
