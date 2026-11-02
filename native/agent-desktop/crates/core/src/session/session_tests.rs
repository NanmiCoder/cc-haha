use super::*;
use crate::refs::refs_test_support::HomeGuard;
use crate::session::{ArtifactsMode, SessionTraceMode};
use std::fs;

#[test]
fn resolve_prefers_explicit_over_env() {
    let _guard = HomeGuard::new();
    let resolved = resolve_active_session(Some("explicit"), Some("env-session")).unwrap();
    assert_eq!(resolved.as_deref(), Some("explicit"));
}

#[test]
fn resolve_uses_env_without_explicit_session() {
    let _guard = HomeGuard::new();
    let resolved = resolve_active_session(None, Some("env-session")).unwrap();
    assert_eq!(resolved.as_deref(), Some("env-session"));
}

#[test]
fn resolve_does_not_infer_an_active_session() {
    let _guard = HomeGuard::new();
    let resolved = resolve_active_session(None, None).unwrap();
    assert!(resolved.is_none());
}

#[test]
fn manifest_round_trips_with_optional_fields() {
    let _guard = HomeGuard::new();
    let manifest = SessionManifest {
        id: "run-1".into(),
        name: Some("demo".into()),
        created_at: 1,
        ended_at: None,
        trace: SessionTraceMode::On,
        artifacts: ArtifactsMode::Events,
        cursor_overlay: crate::CursorOverlayConfig::default(),
    };
    write_manifest(&manifest).unwrap();
    let loaded = read_manifest("run-1").unwrap().expect("manifest");
    assert_eq!(loaded, manifest);
}

#[test]
fn validate_session_name_rejects_control_chars() {
    let err = validate_session_name("bad\u{1}name").unwrap_err();
    assert_eq!(err.code(), "INVALID_ARGS");
}

#[test]
fn start_creates_tree_and_manifest() {
    let _guard = HomeGuard::new();
    let manifest = start_session(StartSessionOptions {
        name: Some("demo".into()),
        trace: SessionTraceMode::On,
        ..Default::default()
    })
    .unwrap();
    assert!(session_dir(&manifest.id).unwrap().join("trace").is_dir());
    assert_eq!(read_manifest(&manifest.id).unwrap().unwrap(), manifest);
}

#[test]
fn start_allows_concurrent_explicit_sessions() {
    let _guard = HomeGuard::new();
    let first = start_session(StartSessionOptions {
        name: None,
        trace: SessionTraceMode::On,
        ..Default::default()
    })
    .unwrap();
    let second = start_session(StartSessionOptions {
        name: None,
        trace: SessionTraceMode::On,
        ..Default::default()
    })
    .unwrap();
    assert_ne!(first.id, second.id);
}

#[test]
fn end_seals_the_explicit_manifest() {
    let _guard = HomeGuard::new();
    let manifest = start_session(StartSessionOptions {
        name: None,
        trace: SessionTraceMode::On,
        ..Default::default()
    })
    .unwrap();
    let ended = end_session(&manifest.id).unwrap();
    assert!(ended.ended_at.is_some());
}

#[test]
fn list_reports_manifest_fields_only() {
    let _guard = HomeGuard::new();
    let manifest = start_session(StartSessionOptions {
        name: Some("listed".into()),
        trace: SessionTraceMode::On,
        ..Default::default()
    })
    .unwrap();
    let listed = list_sessions().unwrap();
    let entry = listed
        .iter()
        .find(|entry| entry.id == manifest.id)
        .expect("started session is listed");
    assert_eq!(entry, &manifest);
}

#[test]
fn trace_enabled_requires_manifest_on() {
    let _guard = HomeGuard::new();
    assert!(!trace_enabled_for_session("missing").unwrap());
    let manifest = start_session(StartSessionOptions {
        name: None,
        trace: SessionTraceMode::Off,
        ..Default::default()
    })
    .unwrap();
    assert!(!trace_enabled_for_session(&manifest.id).unwrap());
}

#[test]
fn new_session_id_includes_process_id() {
    let id = new_session_id();
    assert!(id.contains(&std::process::id().to_string()));
    validate_session_id(&id).expect("new_session_id must always be a valid session id");
}

#[test]
fn corrupt_manifest_is_ignored_not_fatal() {
    let _guard = HomeGuard::new();
    let good = start_session(StartSessionOptions {
        name: None,
        trace: SessionTraceMode::Off,
        ..Default::default()
    })
    .unwrap();
    let bad_dir = session_dir("corruptsess").unwrap();
    fs::create_dir_all(&bad_dir).unwrap();
    fs::write(bad_dir.join("session.json"), b"{ not valid json").unwrap();

    assert!(!trace_enabled_for_session("corruptsess").unwrap());
    let listed: Vec<String> = list_sessions().unwrap().into_iter().map(|m| m.id).collect();
    assert!(listed.contains(&good.id));
    assert!(!listed.iter().any(|id| id == "corruptsess"));
}

#[test]
fn trace_enabled_false_once_session_ended() {
    let _guard = HomeGuard::new();
    let manifest = start_session(StartSessionOptions {
        name: None,
        trace: SessionTraceMode::On,
        ..Default::default()
    })
    .unwrap();
    assert!(trace_enabled_for_session(&manifest.id).unwrap());
    end_session(&manifest.id).unwrap();
    assert!(!trace_enabled_for_session(&manifest.id).unwrap());
}

#[test]
fn start_with_screenshots_records_full_artifacts_mode() {
    let _guard = HomeGuard::new();
    let manifest = start_session(StartSessionOptions {
        artifacts: ArtifactsMode::Full,
        ..Default::default()
    })
    .unwrap();
    assert_eq!(manifest.artifacts, ArtifactsMode::Full);
    let loaded = read_manifest(&manifest.id).unwrap().expect("manifest");
    assert_eq!(loaded.artifacts, ArtifactsMode::Full);
}

#[test]
fn start_without_screenshots_records_events_artifacts_mode() {
    let _guard = HomeGuard::new();
    let manifest = start_session(StartSessionOptions {
        ..Default::default()
    })
    .unwrap();
    assert_eq!(manifest.artifacts, ArtifactsMode::Events);
}

#[test]
fn legacy_manifest_without_artifacts_defaults_to_events() {
    let _guard = HomeGuard::new();
    let dir = session_dir("legacy").unwrap();
    fs::create_dir_all(&dir).unwrap();
    fs::write(
        dir.join("session.json"),
        r#"{"id":"legacy","created_at":1,"trace":"on"}"#,
    )
    .unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(dir.join("session.json"), fs::Permissions::from_mode(0o600)).unwrap();
    }
    let manifest = read_manifest("legacy").unwrap().expect("manifest");
    assert_eq!(manifest.artifacts, ArtifactsMode::Events);
}

#[test]
fn no_trace_with_screenshots_is_invalid_args() {
    let _guard = HomeGuard::new();
    let err = start_session(StartSessionOptions {
        trace: SessionTraceMode::Off,
        artifacts: ArtifactsMode::Full,
        ..Default::default()
    })
    .unwrap_err();
    assert_eq!(err.code(), "INVALID_ARGS");
}

#[test]
fn ended_session_reports_artifacts_full_false() {
    let _guard = HomeGuard::new();
    let manifest = start_session(StartSessionOptions {
        artifacts: ArtifactsMode::Full,
        ..Default::default()
    })
    .unwrap();
    assert!(manifest.artifacts_full());
    end_session(&manifest.id).unwrap();
    let ended = read_manifest(&manifest.id).unwrap().expect("manifest");
    assert!(!ended.artifacts_full());
}

#[cfg(unix)]
#[test]
fn symlinked_manifest_is_ignored_not_fatal() {
    let _guard = HomeGuard::new();
    let good = start_session(StartSessionOptions {
        name: None,
        trace: SessionTraceMode::Off,
        ..Default::default()
    })
    .unwrap();
    let dir = session_dir("symsess").unwrap();
    fs::create_dir_all(&dir).unwrap();
    let target = dir.with_extension("target");
    fs::write(&target, b"{}").unwrap();
    std::os::unix::fs::symlink(&target, dir.join("session.json")).unwrap();

    assert!(!trace_enabled_for_session("symsess").unwrap());
    let ids: Vec<String> = list_sessions().unwrap().into_iter().map(|m| m.id).collect();
    assert!(ids.contains(&good.id));
    assert!(!ids.iter().any(|id| id == "symsess"));
}

#[cfg(unix)]
#[test]
fn legacy_pointer_symlink_does_not_activate_a_session() {
    let _guard = HomeGuard::new();
    let target = agent_desktop_dir().unwrap().join("pointer-target");
    fs::create_dir_all(target.parent().unwrap()).unwrap();
    fs::write(&target, b"whatever").unwrap();
    std::os::unix::fs::symlink(
        &target,
        agent_desktop_dir().unwrap().join("current_session"),
    )
    .unwrap();

    assert!(resolve_active_session(None, None).unwrap().is_none());
}

fn seed_session_refs(id: &str) -> (std::path::PathBuf, String) {
    let store = crate::refs::refs_store::RefStore::for_session(Some(id)).unwrap();
    let snapshot_id = store
        .save_new_snapshot(&crate::RefMap::new())
        .expect("session snapshot");
    let dir = session_dir(id).unwrap();
    let refmaps = dir.join("trace").join("refmaps");
    std::fs::create_dir_all(&refmaps).unwrap();
    std::fs::write(refmaps.join(format!("{snapshot_id}.json")), b"{}").unwrap();
    std::fs::write(
        dir.join("trace").join("42-1.jsonl"),
        b"{\"event\":\"command.start\"}\n",
    )
    .unwrap();
    assert!(dir.join("snapshots").is_dir());
    (dir, snapshot_id)
}

#[test]
fn ending_a_full_artifacts_session_drops_scaffolding_but_keeps_the_recording() {
    let _guard = HomeGuard::new();
    let manifest = start_session(StartSessionOptions {
        name: Some("sealed-full".into()),
        trace: SessionTraceMode::On,
        artifacts: crate::session::manifest::ArtifactsMode::Full,
    })
    .unwrap();
    let (dir, snapshot_id) = seed_session_refs(&manifest.id);

    end_session(&manifest.id).unwrap();

    assert!(!dir.join("snapshots").join(&snapshot_id).exists());
    assert!(!dir.join("latest_snapshot_id").exists());
    assert!(dir.join("trace").join("42-1.jsonl").is_file());
    assert!(dir.join("session.json").is_file());
}

#[test]
fn a_refmap_the_trace_never_copied_survives_ending_a_full_session() {
    let _guard = HomeGuard::new();
    let manifest = start_session(StartSessionOptions {
        name: Some("sealed-partial".into()),
        trace: SessionTraceMode::On,
        artifacts: crate::session::manifest::ArtifactsMode::Full,
    })
    .unwrap();

    let store = crate::refs::refs_store::RefStore::for_session(Some(&manifest.id)).unwrap();
    let copied = store.save_new_snapshot(&crate::RefMap::new()).unwrap();
    let skipped = store.save_new_snapshot(&crate::RefMap::new()).unwrap();
    let dir = session_dir(&manifest.id).unwrap();

    let refmaps = dir.join("trace").join("refmaps");
    std::fs::create_dir_all(&refmaps).unwrap();
    std::fs::write(refmaps.join(format!("{copied}.json")), b"{}").unwrap();

    end_session(&manifest.id).unwrap();

    let snapshots = dir.join("snapshots");
    assert!(
        !snapshots.join(&copied).exists(),
        "a refmap the trace already holds is redundant here"
    );
    assert!(
        snapshots.join(&skipped).is_dir(),
        "deleting a refmap the trace never copied severs snapshot resolution for anyone \
         reading that trace afterwards, permanently"
    );
}

#[test]
fn ending_a_default_session_keeps_refmaps_because_nothing_else_copies_them() {
    let _guard = HomeGuard::new();
    let manifest = start_session(StartSessionOptions {
        name: Some("sealed-events".into()),
        ..Default::default()
    })
    .unwrap();
    assert_eq!(
        manifest.artifacts,
        crate::session::manifest::ArtifactsMode::Events
    );
    let (dir, _snapshot_id) = seed_session_refs(&manifest.id);

    end_session(&manifest.id).unwrap();

    assert!(
        dir.join("snapshots").is_dir(),
        "Events mode never copies refmaps into trace/, so discarding them would sever snapshot_id resolution for trace readers"
    );
    assert!(
        read_manifest(&manifest.id)
            .unwrap()
            .unwrap()
            .ended_at
            .is_some()
    );
}
