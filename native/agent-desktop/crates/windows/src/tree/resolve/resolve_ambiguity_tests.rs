use crate::tree::resolve::*;

use crate::tree::resolve::pair_window::{
    APP_MARKER, DuplicatePairWindow, NAME_MARKER, PairGeometry, TITLE_MARKER, automation_id,
    collect_marked,
};

/// Fails if any marker survived into any operator-visible slot of the error.
fn assert_redacted(error: &AdapterError, secret: &str, slot: &str) {
    let rendered = format!(
        "{} | {} | {} | {}",
        error.message,
        error.suggestion.clone().unwrap_or_default(),
        error.platform_detail.clone().unwrap_or_default(),
        error
            .details
            .as_ref()
            .map(ToString::to_string)
            .unwrap_or_default(),
    );
    assert!(
        !rendered.to_lowercase().contains(&secret.to_lowercase()),
        "the {slot} marker reached an ambiguity error: {rendered}"
    );
}

/// The `AMBIGUOUS_TARGET` branch, driven end to end against two live
/// controls no tier can separate, with the error's redaction guarantee
/// asserted rather than eyeballed.
///
/// The pair shares role, name, `AutomationId` and rectangle, so the identity
/// tiers both match and the bounds tie-break is handed two equal hashes plus
/// the stored one - the arm that must stay ambiguous rather than pick a
/// candidate, since picking one is the silent-wrong-target shape A7-3
/// measured. The second half pins a deliberate divergence from macOS, which
/// embeds entry name, description and window title in its ambiguous details:
/// here the resolver's answer carries shape only - kind and candidate count -
/// with no application-derived text in the message, the suggestion, the
/// platform detail or the details.
#[test]
fn duplicate_evidence_candidates_settle_ambiguous_target_carrying_no_application_text() {
    crate::tree::fixture::ensure_test_apartment();
    let hosted =
        DuplicatePairWindow::create(PairGeometry::Coincident).expect("a duplicate window hosts");
    let deadline = crate::tree::walk::walker_fake::deadline();
    let root = crate::tree::automation::root_from_hwnd(hosted.handle, deadline)
        .expect("the hosted window resolves");
    let source = UiaTreeSource::for_root(&root).expect("a tree source");
    let prepared = source.prepare_root(&root).expect("a prepared root");
    let budget = WalkBudget::new(10, deadline);

    let mut duplicates = Vec::new();
    collect_marked(&source, &prepared, &budget, &mut duplicates);
    assert_eq!(
        duplicates.len(),
        2,
        "the host must present exactly two marked controls"
    );
    let (first, second) = (&duplicates[0], &duplicates[1]);
    let role = first.role.known().cloned().expect("a read role");
    let name = first.name.known().cloned().expect("a read name");
    let native_id = automation_id(first);
    let hash = crate::tree::resolve::resolve_match::bounds_hash_of(first);
    assert_eq!(second.role.known(), Some(&role), "the roles are equal");
    assert_eq!(second.name.known(), Some(&name), "the names are equal");
    assert_eq!(
        automation_id(second),
        native_id,
        "the identifiers are equal"
    );
    assert_eq!(
        crate::tree::resolve::resolve_match::bounds_hash_of(second),
        hash,
        "the bounds hashes are equal, so the tie-break cannot separate them"
    );
    let hash = hash.expect("a positive-area bounds hash");
    let rect = *first
        .ref_evidence
        .bounds
        .known()
        .expect("a read bounds rectangle");

    let pid = agent_desktop_core::ProcessId::from(std::process::id());
    let mut entry = crate::tree::walk::walker_fake::ref_entry(&role);
    entry.process = agent_desktop_core::RefProcess {
        pid,
        process_instance: Some(
            crate::system::process_identity::token_for_pid(pid)
                .expect("the token read answers")
                .expect("a live process has a token"),
        ),
    };
    entry.identity.name = Some(name);
    entry.identity.native_id = native_id;
    entry.geometry = agent_desktop_core::RefGeometry {
        bounds_space: None,
        bounds: Some(rect),
        bounds_hash: Some(hash),
    };
    entry.source.source_app = Some(APP_MARKER.into());
    entry.source.source_window_id = Some(format!("w-{}", hosted.handle));
    entry.source.source_window_title = Some(TITLE_MARKER.into());

    for evidence in &duplicates {
        assert_eq!(
            crate::tree::resolve::resolve_match::candidate_outcome(&entry, evidence),
            CandidateOutcome::Matched,
            "both live controls satisfy the identity tiers"
        );
    }

    let error = resolve_element_strict(&entry, deadline)
        .err()
        .expect("two indistinguishable candidates must not resolve to either one");

    assert_eq!(
        error.code,
        ErrorCode::AmbiguousTarget,
        "the resolver settles ambiguity instead of guessing: {error:?}"
    );
    assert_eq!(
        error
            .details
            .as_ref()
            .and_then(|details| details.get("candidate_count"))
            .and_then(serde_json::Value::as_u64),
        Some(2),
        "the shape-only details report how many candidates matched"
    );
    assert_redacted(&error, NAME_MARKER, "control name");
    assert_redacted(&error, TITLE_MARKER, "window title");
    assert_redacted(&error, APP_MARKER, "application file name");
    assert_redacted(
        &error,
        &automation_id(first)
            .expect("the shared control id surfaces as an automation id")
            .value,
        "automation id",
    );
}
