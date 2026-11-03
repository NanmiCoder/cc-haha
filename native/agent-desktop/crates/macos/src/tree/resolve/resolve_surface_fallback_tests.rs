use super::*;

#[test]
fn ref_surface_fallback_preserves_bridge_miss_unless_a_surface_is_found() {
    let original = AdapterError::new(
        agent_desktop_core::ErrorCode::AppUnresponsive,
        "AX window is not available yet",
    )
    .with_suggestion("Retry after the accessibility windows settle")
    .with_details(serde_json::json!({
        "kind": "resolution_window_bridge_miss",
        "complete": false,
        "retryable": true,
    }));
    let missing = surface_or_bridge_error::<i64>(None, original.clone()).unwrap_err();
    assert_eq!(missing.code, original.code);
    assert_eq!(missing.details, original.details);
    assert_eq!(
        missing.details.as_ref().unwrap()["kind"],
        "resolution_window_bridge_miss"
    );
    assert_eq!(missing.message, original.message);
    assert_eq!(missing.suggestion, original.suggestion);
    assert!(missing.is_explicitly_retryable());
    assert_eq!(surface_or_bridge_error(Some(42), original).unwrap(), 42);
}

#[test]
fn ref_surface_fallback_uses_saved_number_without_bounds_hash() {
    let mut entry: RefEntry = serde_json::from_value(serde_json::json!({
        "pid": 1,
        "role": "button",
        "path": [],
        "states": [],
        "available_actions": [],
        "source_window_id": "w-42"
    }))
    .unwrap();
    entry.source.source_surface = SnapshotSurface::Sheet;
    for hash in [None, Some(123), Some(456)] {
        entry.source.source_window_bounds_hash = hash;
        assert_eq!(
            saved_surface_fallback(&entry, |number| Ok(Some(number))).unwrap(),
            Some(42)
        );
    }
    for id in [None, Some("invalid")] {
        entry.source.source_window_id = id.map(String::from);
        assert!(
            saved_surface_fallback::<i64>(&entry, |_| panic!("missing saved identity"))
                .unwrap()
                .is_none()
        );
    }
}
