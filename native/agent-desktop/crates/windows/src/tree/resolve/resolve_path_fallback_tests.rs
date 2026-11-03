use crate::tree::resolve::*;
use agent_desktop_core::{LocatorEvidence, refs::RefPath};

/// The fixture control the stored ref names. Its role is shared with the
/// window's title-bar buttons, which is what makes a same-role decoy
/// available without the role gate deciding the case first.
const TARGET_NAME: &str = "fixture-button";

fn catalogue(
    source: &UiaTreeSource,
    element: &UIAElement,
    budget: &WalkBudget,
    out: &mut Vec<(RefPath, LocatorEvidence)>,
) {
    crate::tree::walk::walker_fake::walk_all(
        source,
        element,
        budget,
        8,
        &mut |prefix, evidence| {
            let mut path = RefPath::default();
            path.extend_from_slice(prefix);
            out.push((path, evidence));
        },
    );
}

fn stored_entry(
    fixture_handle: isize,
    pid: u32,
    evidence: &LocatorEvidence,
    path: RefPath,
) -> RefEntry {
    let pid = agent_desktop_core::ProcessId::from(pid);
    let mut entry = crate::tree::walk::walker_fake::ref_entry(
        &evidence.role.known().cloned().unwrap_or_default(),
    );
    entry.process = agent_desktop_core::RefProcess {
        pid,
        process_instance: Some(
            crate::system::process_identity::token_for_pid(pid)
                .expect("the token read answers")
                .expect("a live fixture process has a token"),
        ),
    };
    entry.identity.name = evidence.name.known().cloned();
    entry.source.source_app = Some("fixture.exe".into());
    entry.source.source_window_id = Some(format!("w-{fixture_handle}"));
    entry.scope.path_is_absolute = true;
    entry.scope.path = path;
    entry
}

/// The path tier's positive half, driven against a live tree, and the shape a
/// static reading of the resolver mistook for unsound: the tier settles on the
/// element the stored path names, from that element's own evidence and nothing
/// else. No completeness of the surrounding walk is in scope for it - the
/// signature has no room for one - because a landing is the child the stored
/// index names whatever else an enumeration failed to read. What a truncation
/// removes is a suffix, and it lies past the index the walk already used.
///
/// Both directions are pinned on the same live elements: the stored ref's own
/// landing settles, and a same-role landing the stored identity refutes does
/// not. A tier that accepted everything, or nothing, fails one of the two.
#[test]
fn the_path_tier_settles_on_the_element_the_stored_path_names_and_on_no_other() {
    crate::tree::fixture::ensure_test_apartment();
    let fixture = crate::tree::fixture::HostedFixture::spawn().expect("a fixture host starts");
    let deadline = crate::tree::walk::walker_fake::deadline();
    let root = crate::tree::automation::root_from_hwnd(fixture.handle(), deadline)
        .expect("the fixture window resolves");
    let source = UiaTreeSource::for_root(&root).expect("a tree source");
    let prepared = source.prepare_root(&root).expect("a prepared root");
    let budget = WalkBudget::new(10, deadline);

    let mut catalogued = Vec::new();
    catalogue(&source, &prepared, &budget, &mut catalogued);

    let (target_path, target) = catalogued
        .iter()
        .find(|(_, evidence)| {
            evidence
                .name
                .known()
                .is_some_and(|name| name == TARGET_NAME)
        })
        .cloned()
        .expect("the fixture exposes its named button");
    let (decoy_path, _) = catalogued
        .iter()
        .find(|(path, evidence)| {
            path != &target_path
                && evidence.role.known() == target.role.known()
                && evidence.name.known() != target.name.known()
        })
        .cloned()
        .expect("the fixture exposes a same-role control with a different identity");

    let entry = stored_entry(
        fixture.handle(),
        fixture.process_id(),
        &target,
        target_path.clone(),
    );
    let land = |path: &RefPath| {
        crate::tree::resolve::resolve_search::walk_stored_path(&source, &prepared, path, &budget)
            .expect("the path walk answers")
            .element
            .expect("the stored path still lands on a live element")
    };

    assert!(
        crate::tree::resolve::resolve_search::accept_path_landing(
            &source,
            &land(&target_path),
            &entry
        )
        .is_some(),
        "the tier must settle on the element the stored path names"
    );
    assert!(
        crate::tree::resolve::resolve_search::accept_path_landing(
            &source,
            &land(&decoy_path),
            &entry
        )
        .is_none(),
        "a same-role landing the stored identity refutes is never this tier's answer"
    );
}

/// The path fast-path's fall-through, driven against a live tree.
///
/// The stored child-index path still lands on a live element - so this is
/// not the path-missed case - but the element now occupying that index is a
/// different one of the same role, which the identity evidence refutes. A
/// refutation at the stored index is evidence about that element only, never
/// about the stored one, so resolution must continue into the broad search
/// and find the real target elsewhere in the tree. Settling `STALE_REF` there
/// instead would strand every ref whose siblings were reordered.
#[test]
fn a_refuted_element_at_the_stored_path_falls_through_to_the_broad_search() {
    crate::tree::fixture::ensure_test_apartment();
    let fixture = crate::tree::fixture::HostedFixture::spawn().expect("a fixture host starts");
    let deadline = crate::tree::walk::walker_fake::deadline();
    let root = crate::tree::automation::root_from_hwnd(fixture.handle(), deadline)
        .expect("the fixture window resolves");
    let source = UiaTreeSource::for_root(&root).expect("a tree source");
    let prepared = source.prepare_root(&root).expect("a prepared root");
    let budget = WalkBudget::new(10, deadline);

    let mut catalogued = Vec::new();
    catalogue(&source, &prepared, &budget, &mut catalogued);

    let (target_path, target) = catalogued
        .iter()
        .find(|(_, evidence)| {
            evidence
                .name
                .known()
                .is_some_and(|name| name == TARGET_NAME)
        })
        .cloned()
        .expect("the fixture exposes its named button");
    let (decoy_path, decoy) = catalogued
        .iter()
        .find(|(path, evidence)| {
            path != &target_path
                && evidence.role.known() == target.role.known()
                && evidence.name.known() != target.name.known()
        })
        .cloned()
        .expect("the fixture exposes a same-role control with a different identity");

    let entry = stored_entry(
        fixture.handle(),
        fixture.process_id(),
        &target,
        decoy_path.clone(),
    );
    assert!(
        crate::tree::resolve::resolve_search::can_use_path_fast_path(&entry),
        "the fast path must actually run, or the fall-through is never reached"
    );

    let landed = crate::tree::resolve::resolve_search::walk_stored_path(
        &source,
        &prepared,
        &entry.scope.path,
        &budget,
    )
    .expect("the path walk answers")
    .element
    .expect("the stored path still lands on a live element");
    let (_, landed_evidence, _) = source.evidence(&landed);
    assert_eq!(
        landed_evidence.role.known(),
        target.role.known(),
        "the landing shares the stored role, so the role gate is not what rejects it"
    );
    assert_eq!(
        crate::tree::resolve::resolve_match::candidate_outcome(&entry, &landed_evidence),
        CandidateOutcome::Refuted,
        "the element at the stored index is refuted by the stored identity"
    );

    let handle = resolve_element_strict(&entry, deadline)
        .expect("a refutation at the stored path must not settle the resolution");
    let resolved = handle
        .downcast_ref::<UIAElement>()
        .expect("the resolved handle carries a UI Automation element");
    let (_, resolved_evidence, _) = source.evidence(resolved);

    assert_eq!(
        resolved_evidence.name.known(),
        target.name.known(),
        "the broad search found the stored element"
    );
    assert_eq!(
        resolved_evidence.ref_evidence.bounds.known(),
        target.ref_evidence.bounds.known(),
        "the resolved element is the stored one, not the decoy at the stored path"
    );
    assert_ne!(
        resolved_evidence.ref_evidence.bounds.known(),
        decoy.ref_evidence.bounds.known(),
        "the decoy and the target are genuinely different elements"
    );
}
