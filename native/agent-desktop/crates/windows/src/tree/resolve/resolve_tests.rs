use super::pair_window::automation_id;
use super::*;
use agent_desktop_core::{ElementIdentifier, LocatorEvidence};
use std::ops::ControlFlow;

fn capture_identified(
    root: &UIAElement,
    deadline: agent_desktop_core::Deadline,
) -> Option<(Option<ElementIdentifier>, Option<String>, Option<String>)> {
    let source = UiaTreeSource::for_root(root).ok()?;
    let prepared = source.prepare_root(root).ok()?;
    let budget = WalkBudget::new(10, deadline);
    walk_for_identity(&source, &prepared, &budget)
}

fn walk_for_identity(
    source: &UiaTreeSource,
    element: &UIAElement,
    budget: &WalkBudget,
) -> Option<(Option<ElementIdentifier>, Option<String>, Option<String>)> {
    crate::tree::walk::walker_fake::scan_subtree(
        source,
        element,
        budget,
        10,
        &mut |_, _, evidence, _| {
            let native_id = automation_id(&evidence);
            if native_id.is_some() {
                ControlFlow::Break((
                    native_id,
                    evidence.role.known().cloned(),
                    evidence.name.known().cloned(),
                ))
            } else {
                ControlFlow::Continue(())
            }
        },
    )
    .ok()
    .flatten()
}

#[test]
fn a_fixture_ref_resolves_to_the_same_element_end_to_end() {
    crate::tree::fixture::ensure_test_apartment();
    let fixture = crate::tree::fixture::HostedFixture::spawn().expect("a fixture host starts");
    let window = crate::tree::test_support::fixture_window(&fixture);
    let deadline = crate::tree::walk::walker_fake::deadline();
    let root = crate::tree::automation::root_from_hwnd(fixture.handle(), deadline)
        .expect("the fixture window resolves");
    let token = window.process_instance.clone().unwrap();
    let expected_stamp = (window.pid.get(), token.clone());

    let captured = capture_identified(&root, deadline).expect("a fixture element has an id");

    let mut entry =
        crate::tree::walk::walker_fake::ref_entry(&captured.1.clone().unwrap_or_default());
    entry.process = agent_desktop_core::RefProcess {
        pid: window.pid,
        process_instance: Some(token),
    };
    entry.identity.name = captured.2.clone();
    entry.identity.native_id = captured.0.clone();
    entry.source.source_app = Some("fixture.exe".into());
    entry.source.source_window_id = Some(window.id.clone());

    let handle = resolve_element_strict(&entry, deadline)
        .expect("the stored identity re-resolves to a live element");

    assert_verified_stamp(&handle, &expected_stamp, "the broad search");
}

/// Every handle the resolver hands back carries the ref's verified process
/// identity, so the shared live read can corroborate that the provider
/// answering is still the generation resolution verified.
///
/// Without the stamp the corroboration is skipped for every resolved handle,
/// and A14-9's finding - a dead provider's reads succeeding empty on some
/// builds - lands as an answer rather than a `STALE_REF`. The live-read tests
/// build their own stamp, so nothing there notices a resolver that stops
/// producing one; this is the assertion that sees it.
fn assert_verified_stamp(
    handle: &agent_desktop_core::NativeHandle,
    expected: &(u32, String),
    tier: &str,
) {
    let resolved = handle
        .downcast_ref::<UIAElement>()
        .expect("the resolved handle carries a UI Automation element");
    assert_eq!(
        resolved.verified_process(),
        Some((expected.0, expected.1.as_str())),
        "{tier} must stamp the ref's verified process identity onto the handle it returns"
    );
}

/// A ref taken from the fixture's password control - no text identity,
/// positive-area bounds, secure content withheld - resolves through the
/// path fast-path and the geometry tier on an unchanged tree, and the
/// secure value reaches no error or detail.
#[test]
fn a_blank_secure_ref_resolves_through_the_path_and_geometry_tier() {
    crate::tree::fixture::ensure_test_apartment();
    let fixture = crate::tree::fixture::HostedFixture::spawn().expect("a fixture host starts");
    let deadline = crate::tree::walk::walker_fake::deadline();
    let root = crate::tree::automation::root_from_hwnd(fixture.handle(), deadline)
        .expect("the fixture window resolves");
    let source = UiaTreeSource::for_root(&root).expect("a tree source");
    let prepared = source.prepare_root(&root).expect("a prepared root");
    let budget = WalkBudget::new(10, deadline);

    let found = find_password(&source, &prepared, &budget)
        .expect("the fixture exposes a password edit")
        .expect("a password element");
    let (path, _, evidence, _) = found;
    let role = evidence.role.known().cloned();
    let rect = evidence.ref_evidence.bounds.known().expect("a bounds");
    let hash = rect.bounds_hash().expect("a positive-area hash");

    let pid = agent_desktop_core::ProcessId::from(fixture.process_id());
    let token = crate::system::process_identity::token_for_pid(pid)
        .unwrap()
        .expect("a live fixture process has a token");
    let expected_stamp = (pid.get(), token.clone());

    let mut entry = crate::tree::walk::walker_fake::ref_entry(&role.clone().unwrap_or_default());
    entry.process = agent_desktop_core::RefProcess {
        pid,
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
    entry.scope.path = path;

    assert!(
        crate::tree::resolve::resolve_search::can_use_path_fast_path(&entry),
        "a window-rooted path with a positive-area hash qualifies"
    );
    assert!(
        crate::tree::resolve::resolve_search::provisional_geometry_candidate(&entry),
        "no meaningful identity plus a positive-area hash is promotion-eligible"
    );

    let handle = resolve_element_strict(&entry, deadline)
        .expect("the blank secure ref resolves through path and geometry");

    assert_verified_stamp(&handle, &expected_stamp, "the path and geometry tier");
}

fn find_password(
    source: &UiaTreeSource,
    element: &UIAElement,
    budget: &WalkBudget,
) -> Result<
    Option<(
        agent_desktop_core::refs::RefPath,
        crate::tree::properties::ElementProperties,
        LocatorEvidence,
        u64,
    )>,
    AdapterError,
> {
    crate::tree::walk::walker_fake::scan_subtree(
        source,
        element,
        budget,
        10,
        &mut |prefix, properties, evidence, failed| {
            if properties.is_secure() {
                let mut path = agent_desktop_core::refs::RefPath::default();
                path.extend_from_slice(prefix);
                ControlFlow::Break((path, properties, evidence, failed))
            } else {
                ControlFlow::Continue(())
            }
        },
    )
}

/// The cross-process takeover shape, end to end. The stored evidence here
/// genuinely describes a live element - captured from that very tree moments
/// earlier, and proven resolvable by the test above - while the stored
/// process is a *different* process that is alive and of exactly the stored
/// generation. Only the handle's live owner can tell the two apart, so every
/// resolver reaching a window root through `resolve_window_root` must settle
/// `STALE_REF` rather than find the element in an application the ref never
/// named.
#[test]
fn a_ref_whose_window_belongs_to_another_process_never_resolves_into_it() {
    crate::tree::fixture::ensure_test_apartment();
    let fixture = crate::tree::fixture::HostedFixture::spawn().expect("a fixture host starts");
    let deadline = crate::tree::walk::walker_fake::deadline();
    let root = crate::tree::automation::root_from_hwnd(fixture.handle(), deadline)
        .expect("the fixture window resolves");
    let source = UiaTreeSource::for_root(&root).expect("a tree source");
    let prepared = source.prepare_root(&root).expect("a prepared root");
    let budget = WalkBudget::new(10, deadline);

    let (path, _, evidence, _) = find_password(&source, &prepared, &budget)
        .expect("the fixture exposes a password edit")
        .expect("a password element");
    let rect = evidence.ref_evidence.bounds.known().expect("a bounds");
    let hash = rect.bounds_hash().expect("a positive-area hash");

    let pid = agent_desktop_core::ProcessId::from(std::process::id());
    let token = crate::system::process_identity::token_for_pid(pid)
        .expect("the token read answers")
        .expect("a live process has a token");
    assert_ne!(
        pid,
        agent_desktop_core::ProcessId::from(fixture.process_id()),
        "the window under test belongs to a different process than the stored ref"
    );
    assert!(
        crate::system::process_identity::matches_instance(pid, &token)
            .expect("the generation check answers"),
        "the stored process is alive and of the stored generation, so only ownership refutes"
    );

    let mut entry = crate::tree::walk::walker_fake::ref_entry(
        &evidence.role.known().cloned().unwrap_or_default(),
    );
    entry.process = agent_desktop_core::RefProcess {
        pid,
        process_instance: Some(token),
    };
    entry.geometry = agent_desktop_core::RefGeometry {
        bounds_space: None,
        bounds: Some(*rect),
        bounds_hash: Some(hash),
    };
    entry.source.source_window_id = Some(format!("w-{}", fixture.handle()));
    entry.scope.path_is_absolute = true;
    entry.scope.path = path;

    let verdicts = [
        (
            "the window gate itself",
            resolve_window_root(&entry, deadline).err().map(code_of),
        ),
        (
            "the strict resolver",
            resolve_element_strict(&entry, deadline).err().map(code_of),
        ),
        (
            "the locator anchor",
            crate::tree::resolve::resolve_anchor::resolve_locator_anchor(&entry, deadline)
                .err()
                .map(code_of),
        ),
    ];
    assert_eq!(
        verdicts.to_vec(),
        vec![
            ("the window gate itself", Some(ErrorCode::StaleRef)),
            ("the strict resolver", Some(ErrorCode::StaleRef)),
            ("the locator anchor", Some(ErrorCode::StaleRef)),
        ],
        "no resolver may reach into a window another process owns"
    );
}

fn code_of(error: AdapterError) -> ErrorCode {
    error.code
}

#[path = "resolve_retry_tests.rs"]
mod retry;

#[path = "resolve_retry_classification_tests.rs"]
mod retry_classification;

#[path = "resolve_verdict_tests.rs"]
mod verdict;

#[path = "resolve_ambiguity_tests.rs"]
mod ambiguity;

#[path = "resolve_tie_break_tests.rs"]
mod tie_break;

#[path = "resolve_path_fallback_tests.rs"]
mod path_fallback;
