use super::*;

#[test]
fn legacy_window_json_defaults_optional_state() {
    let window: WindowInfo = serde_json::from_value(serde_json::json!({
        "id": "w-1",
        "title": "Document",
        "app_name": "Editor",
        "pid": 42,
        "is_focused": true
    }))
    .expect("legacy window");

    assert!(window.state.is_focused);
    assert!(window.state.accessible);
    assert_eq!(window.state.minimized, None);
    assert_eq!(window.state.visible, None);
}

#[test]
fn optional_window_state_serializes_flat() {
    let window = WindowInfo {
        id: "w-1".into(),
        title: "Document".into(),
        app: "Editor".into(),
        pid: crate::ProcessId::new(42),
        process_instance: Some("42:1".into()),
        bounds: None,
        state: WindowState {
            is_focused: false,
            accessible: true,
            minimized: Some(true),
            visible: Some(false),
        },
    };
    let value = serde_json::to_value(window).expect("window json");

    assert_eq!(value["is_focused"], false);
    assert_eq!(value["accessible"], true);
    assert_eq!(value["minimized"], true);
    assert_eq!(value["visible"], false);
    assert!(value.get("state").is_none());
}
