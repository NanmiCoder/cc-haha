use super::tests::{
    artifacts_session, deadline_png_adapter, entry, png_adapter, run_ref_action,
    setup_artifacts_test,
};
use super::*;
use crate::context::CommandContext;
use crate::refs::RefMap;
use crate::refs::refs_store::RefStore;
use crate::trace::trace_artifacts::clear_test_budgets;
use std::sync::Arc;

#[test]
fn artifacts_full_captures_pre_and_post_pngs() {
    let (_home, _lock) = setup_artifacts_test();
    let manifest = artifacts_session();
    let context = CommandContext::new(Some(manifest.id.clone()), None, false).unwrap();
    run_ref_action(&context, &png_adapter(), 42).unwrap();
    let trace_dir = RefStore::for_session(Some(&manifest.id))
        .unwrap()
        .trace_dir();
    let screens: Vec<_> = std::fs::read_dir(trace_dir.join("screens"))
        .unwrap()
        .map(|e| e.unwrap().path())
        .collect();
    assert_eq!(screens.len(), 2);
    for path in &screens {
        let bytes = std::fs::read(path).unwrap();
        assert_eq!(&bytes[..8], b"\x89PNG\r\n\x1a\n");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }
    let segments: Vec<_> = std::fs::read_dir(&trace_dir)
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|ext| ext == "jsonl"))
        .collect();
    let body = std::fs::read_to_string(segments[0].clone()).unwrap();
    assert!(body.contains("action.artifacts"));
    assert!(body.contains("screens/"));
}

#[test]
fn artifact_capture_budget_supports_deadline_bound_screenshot_backends() {
    let (_home, _lock) = setup_artifacts_test();
    let manifest = artifacts_session();
    let context = CommandContext::new(Some(manifest.id.clone()), None, false).unwrap();
    run_ref_action(&context, &deadline_png_adapter(250), 42).unwrap();
    let screens = RefStore::for_session(Some(&manifest.id))
        .unwrap()
        .trace_dir()
        .join("screens");

    assert_eq!(std::fs::read_dir(screens).unwrap().count(), 2);
}

#[test]
fn byte_budget_exhaustion_skips_with_budget_reason() {
    let (_home, _lock) = setup_artifacts_test();
    set_test_budgets(10, 200, 64 * 1024 * 1024);
    let manifest = artifacts_session();
    let context = CommandContext::new(Some(manifest.id.clone()), None, false).unwrap();
    run_ref_action(&context, &png_adapter(), 1).unwrap();
    let trace_dir = RefStore::for_session(Some(&manifest.id))
        .unwrap()
        .trace_dir();
    assert_eq!(
        std::fs::read_dir(trace_dir.join("screens"))
            .map(|dir| dir.count())
            .unwrap_or(0),
        0
    );
    let body = std::fs::read_dir(&trace_dir)
        .unwrap()
        .find_map(|e| {
            let p = e.ok()?.path();
            p.extension()
                .is_some_and(|ext| ext == "jsonl")
                .then_some(std::fs::read_to_string(p).ok())
        })
        .flatten()
        .unwrap();
    assert!(body.contains("\"skipped\":\"budget\""));
    clear_test_budgets();
}

#[test]
fn concurrent_capture_produces_distinct_filenames() {
    let (_home, _lock) = setup_artifacts_test();
    let manifest = artifacts_session();
    let session_home = crate::refs::home_dir().unwrap();
    let context = Arc::new(CommandContext::new(Some(manifest.id.clone()), None, false).unwrap());
    let adapter = Arc::new(png_adapter());
    let handles: Vec<_> = (0..4)
        .map(|_| {
            let context = context.clone();
            let adapter = adapter.clone();
            let session_home = session_home.clone();
            std::thread::spawn(move || {
                crate::refs::set_home_override(Some(session_home));
                run_ref_action(&context, adapter.as_ref(), 7)
            })
        })
        .collect();
    for handle in handles {
        handle.join().unwrap().unwrap();
    }
    let trace_dir = RefStore::for_session(Some(&manifest.id))
        .unwrap()
        .trace_dir();
    let mut on_disk: Vec<String> = std::fs::read_dir(trace_dir.join("screens"))
        .unwrap()
        .map(|e| format!("screens/{}", e.unwrap().file_name().to_string_lossy()))
        .collect();
    on_disk.sort();
    let segment = std::fs::read_dir(&trace_dir)
        .unwrap()
        .find_map(|e| {
            let p = e.ok()?.path();
            p.extension().is_some_and(|ext| ext == "jsonl").then_some(p)
        })
        .unwrap();
    let mut recorded: Vec<String> = std::fs::read_to_string(segment)
        .unwrap()
        .lines()
        .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
        .filter(|event| event["event"] == "action.artifacts")
        .flat_map(|event| {
            ["screenshot_pre", "screenshot_post"]
                .into_iter()
                .filter_map(move |key| event[key].as_str().map(str::to_owned))
        })
        .collect();
    recorded.sort();
    assert!(
        !recorded.is_empty(),
        "at least the capture that won the artifact lock must land"
    );
    assert_eq!(
        recorded, on_disk,
        "every capture the trace reports must be its own file, none overwritten"
    );
}

#[test]
fn refmap_copy_is_idempotent_and_byte_equal() {
    let (_home, _lock) = setup_artifacts_test();
    let manifest = artifacts_session();
    let context = CommandContext::new(Some(manifest.id.clone()), None, false).unwrap();
    let store = RefStore::for_session(Some(&manifest.id)).unwrap();
    let mut refmap = RefMap::new();
    refmap.allocate(entry(1));
    let snapshot_id = store.save_new_snapshot(&refmap).unwrap();
    copy_refmap_if_full(&context, &store, &snapshot_id, &refmap).unwrap();
    copy_refmap_if_full(&context, &store, &snapshot_id, &refmap).unwrap();
    let copied = store
        .trace_dir()
        .join("refmaps")
        .join(format!("{snapshot_id}.json"));
    let source = store
        .base_dir()
        .join("snapshots")
        .join(&snapshot_id)
        .join("refmap.json");
    assert_eq!(
        std::fs::read(copied).unwrap(),
        std::fs::read(source).unwrap()
    );
}

#[test]
fn copy_refmap_internal_failure_is_best_effort() {
    let (_home, _lock) = setup_artifacts_test();
    let manifest = artifacts_session();
    let context = CommandContext::new(Some(manifest.id.clone()), None, false).unwrap();
    let store = RefStore::for_session(Some(&manifest.id)).unwrap();
    let mut refmap = RefMap::new();
    refmap.allocate(entry(1));
    let snapshot_id = store.save_new_snapshot(&refmap).unwrap();

    let trace_dir = store.trace_dir();
    std::fs::create_dir_all(&trace_dir).unwrap();
    let refmaps_path = trace_dir.join("refmaps");
    std::fs::write(&refmaps_path, b"blocking file, not a directory").unwrap();

    let result = copy_refmap_if_full(&context, &store, &snapshot_id, &refmap);

    assert!(
        result.is_ok(),
        "artifact capture must never fail the primary command: {result:?}"
    );
    assert!(
        refmaps_path.is_file(),
        "blocking file should be left untouched by the best-effort skip"
    );
}
