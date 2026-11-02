use super::*;

#[test]
fn action_availability_makes_toggle_and_expand_applicable() {
    let _guard = HomeGuard::new();
    let snapshot_id = save_entry(RefEntry {
        process: crate::RefProcess {
            pid: crate::ProcessId::new(1),
            process_instance: Some("test-instance".into()),
        },
        identity: crate::RefEntryIdentity {
            retained_object: None,
            role: "cell".into(),
            name: Some("Disclosure".into()),
            value: None,
            description: None,
            native_id: None,
        },
        geometry: crate::RefGeometry {
            bounds_space: None,
            bounds: None,
            bounds_hash: None,
        },
        capabilities: crate::RefCapabilities {
            states: vec![],
            available_actions: vec!["Check".into(), "Expand".into()],
        },
        source: crate::RefSource {
            source_app: None,
            source_window_id: None,
            source_window_title: None,
            source_window_bounds_hash: None,
            source_surface: crate::adapter::SnapshotSurface::Window,
        },
        scope: crate::RefScope {
            root_ref: None,
            path_is_absolute: false,
            path: smallvec::SmallVec::new(),
        },
    });
    let adapter = LiveStateAdapter {
        state: Mutex::new(None),
        bounds: Mutex::new(None),
        bounds_supported: false,
        state_supported: true,
    };

    for property in [IsProperty::Checked, IsProperty::Expanded] {
        let result = execute(
            IsArgs {
                ref_id: format!("@{}:e1", snapshot_id.clone()),
                property,
            },
            &adapter,
            &CommandContext::default(),
        )
        .unwrap();

        assert_eq!(result["applicable"], true);
    }
}
