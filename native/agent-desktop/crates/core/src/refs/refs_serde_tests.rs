use super::*;
use crate::adapter::SnapshotSurface;

fn minimal_entry(role: &str) -> RefEntry {
    RefEntry {
        process: crate::RefProcess {
            pid: crate::ProcessId::new(1),
            process_instance: Some("test-instance".into()),
        },
        identity: crate::RefEntryIdentity {
            retained_object: None,
            role: role.into(),
            name: None,
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
            available_actions: vec![],
        },
        source: crate::RefSource {
            source_app: None,
            source_window_id: None,
            source_window_title: None,
            source_window_bounds_hash: Some(0xA11C_E551),
            source_surface: SnapshotSurface::Window,
        },
        scope: crate::RefScope {
            root_ref: None,
            path_is_absolute: false,
            path: smallvec::SmallVec::new(),
        },
    }
}

/// Fields annotated with `skip_serializing_if` must be absent from the JSON
/// when they hold their zero/empty/default value. Agents parsing the wire
/// format must not break if any of these keys are missing.
#[test]
fn ref_entry_skip_fields_absent_when_none_empty_or_default() {
    let e = minimal_entry("button");
    let json = serde_json::to_string(&e).unwrap();

    assert!(
        !json.contains("\"value\":"),
        "value absent when None, json={json}"
    );
    assert!(
        !json.contains("\"description\":"),
        "description absent when None, json={json}"
    );
    assert!(
        !json.contains("\"states\":"),
        "states absent when empty, json={json}"
    );
    assert!(
        !json.contains("\"bounds\":"),
        "bounds absent when None, json={json}"
    );
    assert!(
        !json.contains("\"source_window_id\":"),
        "source_window_id absent when None, json={json}"
    );
    assert!(
        !json.contains("\"source_window_title\":"),
        "source_window_title absent when None, json={json}"
    );
    assert!(
        !json.contains("\"source_surface\":"),
        "source_surface absent for Window default, json={json}"
    );
    assert!(
        !json.contains("\"root_ref\":"),
        "root_ref absent when None, json={json}"
    );
    assert!(
        !json.contains("\"path_is_absolute\":"),
        "path_is_absolute absent when false, json={json}"
    );
    assert!(
        !json.contains("\"path\":"),
        "path absent when empty, json={json}"
    );
}

/// SnapshotSurface::Window is omitted from RefEntry JSON because it is the
/// default surface. A non-Window surface must appear as its snake_case string.
/// This pins the #[serde(skip_serializing_if = "SnapshotSurface::is_window")]
/// annotation on RefEntry.source_surface.
#[test]
fn ref_entry_source_surface_omitted_for_window_present_for_non_window() {
    let window_entry = minimal_entry("button");
    let window_json = serde_json::to_string(&window_entry).unwrap();
    assert!(
        !window_json.contains("\"source_surface\":"),
        "Window surface must be omitted as the default, json={window_json}"
    );

    let mut alert_entry = minimal_entry("button");
    alert_entry.source.source_surface = SnapshotSurface::Alert;
    let alert_json = serde_json::to_string(&alert_entry).unwrap();
    assert!(
        alert_json.contains("\"source_surface\":\"alert\""),
        "Alert surface must serialize to 'alert', json={alert_json}"
    );

    let mut menu_entry = minimal_entry("button");
    menu_entry.source.source_surface = SnapshotSurface::Menu;
    let menu_json = serde_json::to_string(&menu_entry).unwrap();
    assert!(
        menu_json.contains("\"source_surface\":\"menu\""),
        "Menu surface must serialize to 'menu', json={menu_json}"
    );
}

/// Every SnapshotSurface variant must serialize to its snake_case string
/// and round-trip through serde. This pins the wire format against accidental
/// rename and confirms #[non_exhaustive] has not changed existing variant names.
#[test]
fn snapshot_surface_serializes_to_snake_case_and_roundtrips() {
    let cases = [
        (SnapshotSurface::Window, "\"window\""),
        (SnapshotSurface::Focused, "\"focused\""),
        (SnapshotSurface::Menu, "\"menu\""),
        (SnapshotSurface::Menubar, "\"menubar\""),
        (SnapshotSurface::Sheet, "\"sheet\""),
        (SnapshotSurface::Popover, "\"popover\""),
        (SnapshotSurface::Alert, "\"alert\""),
        (SnapshotSurface::Desktop, "\"desktop\""),
        (SnapshotSurface::Taskbar, "\"taskbar\""),
        (SnapshotSurface::SystemTray, "\"system_tray\""),
        (SnapshotSurface::QuickSettings, "\"quick_settings\""),
        (
            SnapshotSurface::NotificationCenter,
            "\"notification_center\"",
        ),
        (SnapshotSurface::Toolbar, "\"toolbar\""),
        (SnapshotSurface::Dock, "\"dock\""),
        (SnapshotSurface::Spotlight, "\"spotlight\""),
        (SnapshotSurface::MenuBarExtras, "\"menu_bar_extras\""),
        (
            SnapshotSurface::SystemTrayOverflow,
            "\"system_tray_overflow\"",
        ),
        (SnapshotSurface::StartMenu, "\"start_menu\""),
        (SnapshotSurface::ActionCenter, "\"action_center\""),
    ];
    for (variant, _) in cases {
        let token = serde_json::to_string(variant.as_str()).unwrap();
        let parsed: SnapshotSurface = serde_json::from_str(&token)
            .unwrap_or_else(|error| panic!("emitted token {token} must deserialize: {error}"));
        assert_eq!(
            parsed, variant,
            "the token as_str emits must name {variant:?}"
        );
    }
    for (variant, expected_json) in cases {
        let serialized = serde_json::to_string(&variant).unwrap();
        assert_eq!(
            serialized, expected_json,
            "wrong wire string for {variant:?}"
        );
        let back: SnapshotSurface = serde_json::from_str(&serialized).unwrap();
        assert_eq!(back, variant, "round-trip failed for {variant:?}");
    }
}

/// RefEntry serializes and deserializes back to the same field values.
/// Uses field-by-field comparison because RefEntry does not derive PartialEq.
#[test]
fn ref_entry_full_roundtrip_preserves_all_fields() {
    let original = RefEntry {
        process: crate::RefProcess {
            pid: crate::ProcessId::new(99),
            process_instance: Some("test-instance".into()),
        },
        identity: crate::RefEntryIdentity {
            retained_object: None,
            role: "textfield".into(),
            name: Some("Email".into()),
            value: Some("user@example.com".into()),
            description: Some("Enter email".into()),
            native_id: Some(crate::ElementIdentifier {
                kind: crate::IdentifierKind::AxIdentifier,
                value: "email-field".into(),
            }),
        },
        geometry: crate::RefGeometry {
            bounds_space: None,
            bounds: None,
            bounds_hash: Some(0xDEAD_BEEF),
        },
        capabilities: crate::RefCapabilities {
            states: vec!["focused".into()],
            available_actions: vec!["SetValue".into(), "Click".into()],
        },
        source: crate::RefSource {
            source_app: Some("Mail".into()),
            source_window_id: Some("w-7".into()),
            source_window_title: Some("Compose".into()),
            source_window_bounds_hash: None,
            source_surface: SnapshotSurface::Sheet,
        },
        scope: crate::RefScope {
            root_ref: Some("@e5".into()),
            path_is_absolute: true,
            path: smallvec::SmallVec::from_slice(&[2, 0, 1]),
        },
    };
    let json = serde_json::to_string(&original).unwrap();
    let back: RefEntry = serde_json::from_str(&json).unwrap();

    assert_eq!(back, original);
}

#[test]
fn legacy_ref_entry_json_without_bounds_space_deserializes_to_none() {
    let bounds = crate::Rect {
        x: 4.0,
        y: 8.0,
        width: 120.0,
        height: 24.0,
    };
    let mut entry = minimal_entry("button");
    entry.geometry = crate::RefGeometry {
        bounds: Some(bounds),
        bounds_hash: bounds.bounds_hash(),
        bounds_space: None,
    };

    let json = serde_json::to_string(&entry).unwrap();
    assert!(
        !json.contains("\"bounds_space\""),
        "a screen rectangle writes no bounds_space key, json={json}"
    );

    let back: RefEntry = serde_json::from_str(&json).unwrap();
    assert_eq!(back.geometry.bounds_space, None);
    assert_eq!(back.geometry.bounds, Some(bounds));
}

#[test]
fn window_bounds_space_round_trips_as_window() {
    let mut entry = minimal_entry("button");
    entry.geometry.bounds_space = Some(crate::BoundsSpace::Window);
    entry.geometry.bounds = Some(crate::Rect {
        x: 4.0,
        y: 8.0,
        width: 120.0,
        height: 24.0,
    });

    let json = serde_json::to_string(&entry).unwrap();
    assert!(
        json.contains("\"bounds_space\":\"window\""),
        "a window rectangle names its space as 'window', json={json}"
    );

    let back: RefEntry = serde_json::from_str(&json).unwrap();
    assert_eq!(back.geometry.bounds_space, Some(crate::BoundsSpace::Window));
}

#[test]
fn refmap_round_trip_keeps_bounds_on_a_rounding_boundary() {
    let bounds = crate::Rect {
        x: 505.24,
        y: 505.04499999999996,
        width: 1168.09,
        height: 25.024999999999977,
    };
    let mut entry = minimal_entry("button");
    entry.geometry = crate::RefGeometry {
        bounds_space: None,
        bounds: Some(bounds),
        bounds_hash: bounds.bounds_hash(),
    };
    let mut map = RefMap::new();
    let ref_id = map.try_allocate(entry).unwrap();

    let json = map.serialize_with_size_check().unwrap();
    assert!(json.contains("505.04499999999996"), "json={json}");
    let restored: RefMap = serde_json::from_str(&json).unwrap();

    restored.validate().unwrap();
    let restored_bounds = restored.get(&ref_id).unwrap().geometry.bounds.unwrap();
    assert_eq!(restored_bounds.y.to_bits(), bounds.y.to_bits());
}
