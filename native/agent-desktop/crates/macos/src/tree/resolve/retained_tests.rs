use super::*;
use agent_desktop_core::{LocatorField, LocatorRefEvidence};

fn app(pid: i32) -> AXElement {
    AXElement(unsafe { accessibility_sys::AXUIElementCreateApplication(pid) })
}

fn entry(token: Option<String>) -> RefEntry {
    RefEntry {
        process: agent_desktop_core::RefProcess {
            pid: agent_desktop_core::ProcessId::new(1),
            process_instance: None,
        },
        identity: agent_desktop_core::RefEntryIdentity {
            retained_object: token,
            role: "button".into(),
            name: Some("Target".into()),
            value: None,
            description: None,
            native_id: None,
        },
        geometry: agent_desktop_core::RefGeometry {
            bounds_space: None,
            bounds: None,
            bounds_hash: None,
        },
        capabilities: agent_desktop_core::RefCapabilities {
            states: Vec::new(),
            available_actions: Vec::new(),
        },
        source: agent_desktop_core::RefSource {
            source_app: None,
            source_window_id: None,
            source_window_title: None,
            source_window_bounds_hash: None,
            source_surface: agent_desktop_core::SnapshotSurface::Window,
        },
        scope: agent_desktop_core::RefScope {
            root_ref: None,
            path_is_absolute: false,
            path: Default::default(),
        },
    }
}

fn text_evidence(name: &str) -> agent_desktop_core::LocatorEvidence {
    agent_desktop_core::LocatorEvidence {
        role: LocatorField::Known("button".into()),
        name: LocatorField::Known(name.into()),
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
    }
}

#[test]
fn retention_uses_native_equality_and_expires_with_its_owner() {
    let pid = i32::try_from(std::process::id()).unwrap();
    let element = app(pid);
    assert!(capture(&element).unwrap().is_none());
    let owner = RetainedRefSession::start().unwrap();
    assert!(RetainedRefSession::start().is_err());
    let first = capture(&element).unwrap().unwrap();
    let same = capture(&app(pid)).unwrap().unwrap();
    assert_eq!(first, same);
    assert!(matches(&first, &app(pid)).unwrap());
    assert!(!matches(&first, &app(1)).unwrap());
    assert!(capture(&AXElement(std::ptr::null_mut())).is_err());
    assert_eq!(
        evidence(&element, IdentifierEvidence::absent()).retained_object(),
        Some(first.as_str())
    );
    drop(owner);
    assert_eq!(
        validate(Some(&first)).unwrap_err().code,
        agent_desktop_core::ErrorCode::StaleRef
    );
    let _replacement_owner = RetainedRefSession::start().unwrap();
    let replacement = capture(&element).unwrap().unwrap();
    assert_ne!(replacement, first);
    assert!(validate(Some(&first)).is_err());
}

#[test]
fn candidate_match_prefers_native_identity_over_matching_text_evidence() {
    let pid = i32::try_from(std::process::id()).unwrap();
    let _owner = RetainedRefSession::start().unwrap();
    let token = capture(&app(pid)).unwrap().unwrap();
    let retained_entry = entry(Some(token));
    let matching_text = text_evidence("Target");
    assert_eq!(
        candidate_match(&app(pid), &retained_entry, &matching_text).unwrap(),
        agent_desktop_core::IdentityMatch::Match
    );
    assert_eq!(
        candidate_match(&app(1), &retained_entry, &matching_text).unwrap(),
        agent_desktop_core::IdentityMatch::NoMatch
    );
}

#[test]
fn candidate_match_fails_closed_on_a_stale_token() {
    let pid = i32::try_from(std::process::id()).unwrap();
    let owner = RetainedRefSession::start().unwrap();
    let token = capture(&app(pid)).unwrap().unwrap();
    drop(owner);
    let _replacement = RetainedRefSession::start().unwrap();
    let error =
        candidate_match(&app(pid), &entry(Some(token)), &text_evidence("Target")).unwrap_err();
    assert_eq!(error.code, agent_desktop_core::ErrorCode::StaleRef);
    assert_eq!(
        error.message,
        "The native object owner is no longer available"
    );
    assert_eq!(
        error.suggestion.as_deref(),
        Some("Take a fresh snapshot in the active session")
    );
    assert_eq!(
        error.disposition,
        agent_desktop_core::DeliverySemantics::not_delivered()
    );
}

#[test]
fn tokenless_candidates_keep_the_legacy_identity_rules() {
    let pid = i32::try_from(std::process::id()).unwrap();
    let tokenless = entry(None);
    assert_eq!(
        candidate_match(&app(pid), &tokenless, &text_evidence("Target")).unwrap(),
        agent_desktop_core::IdentityMatch::Match
    );
    assert_eq!(
        candidate_match(&app(pid), &tokenless, &text_evidence("Other")).unwrap(),
        agent_desktop_core::IdentityMatch::NoMatch
    );
}

#[test]
fn retention_cannot_cross_threads() {
    let _owner = RetainedRefSession::start().unwrap();
    let token = capture(&app(i32::try_from(std::process::id()).unwrap()))
        .unwrap()
        .unwrap();
    std::thread::spawn(move || {
        assert_eq!(
            validate(Some(&token)).unwrap_err().code,
            agent_desktop_core::ErrorCode::StaleRef
        );
    })
    .join()
    .unwrap();
}
