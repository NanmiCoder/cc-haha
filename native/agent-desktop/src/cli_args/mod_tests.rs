use super::*;
use agent_desktop_core::SnapshotSurface;
use clap::ValueEnum;

const EXPECTED_CORE_SURFACES: &[SnapshotSurface] = &[
    SnapshotSurface::Window,
    SnapshotSurface::Focused,
    SnapshotSurface::Menu,
    SnapshotSurface::Menubar,
    SnapshotSurface::Sheet,
    SnapshotSurface::Popover,
    SnapshotSurface::Alert,
    SnapshotSurface::Desktop,
    SnapshotSurface::Taskbar,
    SnapshotSurface::SystemTray,
    SnapshotSurface::QuickSettings,
    SnapshotSurface::NotificationCenter,
    SnapshotSurface::Toolbar,
    SnapshotSurface::Dock,
    SnapshotSurface::Spotlight,
    SnapshotSurface::MenuBarExtras,
    SnapshotSurface::SystemTrayOverflow,
    SnapshotSurface::StartMenu,
    SnapshotSurface::ActionCenter,
];

#[test]
fn surface_to_core_maps_one_to_one_onto_expected_core_surfaces() {
    let mapped: Vec<_> = Surface::value_variants()
        .iter()
        .map(Surface::to_core)
        .collect();
    assert_eq!(mapped, EXPECTED_CORE_SURFACES);
}

#[test]
fn find_args_cli_flags_still_resolve_through_flattened_groups() {
    let args = FindArgs::try_parse_from([
        "find", "--role", "button", "--name", "Save", "--exact", "--first",
    ])
    .unwrap();

    assert_eq!(args.filter.role.as_deref(), Some("button"));
    assert_eq!(args.filter.name.as_deref(), Some("Save"));
    assert!(args.filter.exact);
    assert!(args.selection.first);
}

#[test]
fn find_accepts_a_drill_down_root_and_leaves_it_unset_by_default() {
    let scoped =
        FindArgs::try_parse_from(["find", "--root", "@s1:e4", "--role", "button"]).unwrap();
    assert_eq!(scoped.root.as_deref(), Some("@s1:e4"));

    let unscoped = FindArgs::try_parse_from(["find", "--role", "button"]).unwrap();
    assert!(unscoped.root.is_none());
}

#[test]
fn find_args_selection_conflicts_still_enforced_across_the_flatten_boundary() {
    let err = FindArgs::try_parse_from(["find", "--first", "--last"]).unwrap_err();

    assert_eq!(err.kind(), clap::error::ErrorKind::ArgumentConflict);
}

#[test]
fn find_args_batch_json_flat_payload_deserializes_into_nested_groups() {
    let args: FindArgs = serde_json::from_value(serde_json::json!({
        "role": "checkbox",
        "native_id": "agree",
        "count": true
    }))
    .unwrap();

    assert_eq!(args.filter.role.as_deref(), Some("checkbox"));
    assert_eq!(args.filter.native_id.as_deref(), Some("agree"));
    assert!(args.selection.count);
    assert!(args.states.is_empty());
}

#[test]
fn find_args_batch_json_flat_scope_deserializes_into_scope_group() {
    let args: FindArgs = serde_json::from_value(serde_json::json!({
        "app": "Finder",
        "window_id": "w-2"
    }))
    .unwrap();

    assert_eq!(args.scope.app.as_deref(), Some("Finder"));
    assert_eq!(args.scope.window_id.as_deref(), Some("w-2"));
    assert!(args.filter.role.is_none());
}

#[test]
fn find_args_batch_json_rejects_scope_field_typo() {
    let err = serde_json::from_value::<FindArgs>(serde_json::json!({
        "ap": "Finder",
        "window_id": "w-2"
    }))
    .unwrap_err();
    assert!(err.to_string().contains("`ap`"));

    let err = serde_json::from_value::<FindArgs>(serde_json::json!({
        "app": "Finder",
        "windo_id": "w-2"
    }))
    .unwrap_err();
    assert!(err.to_string().contains("`windo_id`"));
}

#[test]
fn snapshot_args_batch_json_flat_scope_deserializes_into_scope_group() {
    let args: SnapshotArgs = serde_json::from_value(serde_json::json!({
        "app": "Finder",
        "window_id": "w-2"
    }))
    .unwrap();

    assert_eq!(args.scope.app.as_deref(), Some("Finder"));
    assert_eq!(args.scope.window_id.as_deref(), Some("w-2"));
    assert_eq!(args.tree.max_depth, 10);
}

#[test]
fn snapshot_args_batch_json_rejects_scope_field_typo() {
    let err = serde_json::from_value::<SnapshotArgs>(serde_json::json!({
        "ap": "Finder",
        "window_id": "w-2"
    }))
    .unwrap_err();
    assert!(err.to_string().contains("`ap`"));

    let err = serde_json::from_value::<SnapshotArgs>(serde_json::json!({
        "app": "Finder",
        "windo_id": "w-2"
    }))
    .unwrap_err();
    assert!(err.to_string().contains("`windo_id`"));
}

#[test]
fn screenshot_args_batch_json_flat_scope_deserializes_into_scope_group() {
    let args: ScreenshotArgs = serde_json::from_value(serde_json::json!({
        "app": "Finder",
        "window_id": "w-2"
    }))
    .unwrap();

    assert_eq!(args.scope.app.as_deref(), Some("Finder"));
    assert_eq!(args.scope.window_id.as_deref(), Some("w-2"));
    assert!(args.screen.is_none());
}

#[test]
fn screenshot_args_batch_json_rejects_scope_field_typo() {
    let err = serde_json::from_value::<ScreenshotArgs>(serde_json::json!({
        "ap": "Finder",
        "window_id": "w-2"
    }))
    .unwrap_err();
    assert!(err.to_string().contains("`ap`"));

    let err = serde_json::from_value::<ScreenshotArgs>(serde_json::json!({
        "app": "Finder",
        "windo_id": "w-2"
    }))
    .unwrap_err();
    assert!(err.to_string().contains("`windo_id`"));
}

/// The `--timeout-ms` knob (A16-11): omitted on the CLI it stays `None` so
/// the core `DEFAULT_SNAPSHOT_TIMEOUT_MS` (3 s) is preserved, and the
/// `--force-electron-a11y` observation-mode flag defaults off.
#[test]
fn snapshot_args_cli_timeout_preserves_the_core_default_when_omitted() {
    let args = SnapshotArgs::try_parse_from(["snapshot"]).unwrap();
    assert_eq!(args.timeout_ms, None);
    assert!(!args.force_electron_a11y);
}

#[test]
fn snapshot_args_cli_raises_the_timeout_and_forces_electron_a11y() {
    let args = SnapshotArgs::try_parse_from([
        "snapshot",
        "--timeout-ms",
        "15000",
        "--force-electron-a11y",
    ])
    .unwrap();
    assert_eq!(args.timeout_ms, Some(15000));
    assert!(args.force_electron_a11y);
}

/// Batch JSON omitting `timeout_ms`/`force_electron_a11y` (the shape every
/// existing caller sends, since both fields are additive) must still
/// deserialize `SnapshotArgs`, matching the CLI's own omitted-flag defaults:
/// `None` so `DEFAULT_SNAPSHOT_TIMEOUT_MS` applies, and `force_electron_a11y`
/// off.
#[test]
fn snapshot_args_batch_json_defaults_timeout_and_force_electron_a11y_when_absent() {
    let args: SnapshotArgs = serde_json::from_value(serde_json::json!({
        "app": "Finder",
        "window_id": "w-2"
    }))
    .unwrap();

    assert_eq!(args.timeout_ms, None);
    assert!(!args.force_electron_a11y);
}
