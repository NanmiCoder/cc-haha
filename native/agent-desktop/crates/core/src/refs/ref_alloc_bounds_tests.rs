use super::*;

/// A nameless element's positive-area rect is the only evidence any
/// resolution tier can verify its ref against, so allocation must keep it
/// even when the snapshot hides bounds. Stripping it here leaves the ref
/// with nothing to be resolved by (the A24-11 stale-rate mechanism).
#[test]
fn a_nameless_positive_area_ref_allocated_with_bounds_hidden_keeps_its_only_identity() {
    let mut root = node("window", Some("w"));
    root.children = vec![node("button", None)];
    let mut refmap = RefMap::new();
    let config = RefAllocConfig {
        options: crate::refs::ref_alloc_options::RefAllocOptions {
            include_bounds: false,
            interactive_only: false,
            compact: false,
        },
        source: crate::refs::ref_alloc_source::RefAllocSource {
            pid: crate::ProcessId::new(7),
            app: Some("Finder"),
            window_id: Some("w-42"),
            window_title: Some("Documents"),
            window_bounds_hash: None,
            process_instance: Some("test-instance"),
            surface: crate::adapter::SnapshotSurface::Window,
        },
        scope: crate::refs::ref_alloc_scope::RefAllocScope {
            root_ref_id: None,
            path_prefix: &[],
        },
    };

    let out = allocate_refs(root, &mut refmap, &config).unwrap();
    let open_ref = out.children[0].ref_id.as_deref().unwrap();
    let entry = refmap.get(open_ref).unwrap();

    assert!(!crate::refs::ref_identity::has_meaningful_identity(entry));
    assert_eq!(
        entry.geometry.bounds,
        Some(Rect {
            x: 0.0,
            y: 0.0,
            width: 10.0,
            height: 10.0,
        })
    );
    assert_eq!(entry.geometry.bounds_hash, Some(entry_hash()));
}

/// The size optimisation is narrowed, not removed: an entry that carries an
/// identity of its own is resolved by that identity, so its rect is still
/// stripped when the snapshot hides bounds.
#[test]
fn a_ref_with_its_own_identity_still_has_its_rect_stripped() {
    let mut root = node("window", Some("w"));
    root.children = vec![node("button", Some("Open"))];
    let mut refmap = RefMap::new();
    let config = RefAllocConfig {
        options: crate::refs::ref_alloc_options::RefAllocOptions {
            include_bounds: false,
            interactive_only: false,
            compact: false,
        },
        source: crate::refs::ref_alloc_source::RefAllocSource {
            pid: crate::ProcessId::new(7),
            app: Some("Finder"),
            window_id: Some("w-42"),
            window_title: Some("Documents"),
            window_bounds_hash: None,
            process_instance: Some("test-instance"),
            surface: crate::adapter::SnapshotSurface::Window,
        },
        scope: crate::refs::ref_alloc_scope::RefAllocScope {
            root_ref_id: None,
            path_prefix: &[],
        },
    };

    let out = allocate_refs(root, &mut refmap, &config).unwrap();
    let open_ref = out.children[0].ref_id.as_deref().unwrap();
    let entry = refmap.get(open_ref).unwrap();

    assert!(crate::refs::ref_identity::has_meaningful_identity(entry));
    assert!(entry.geometry.bounds.is_none());
    assert_eq!(entry.geometry.bounds_hash, Some(entry_hash()));
}
