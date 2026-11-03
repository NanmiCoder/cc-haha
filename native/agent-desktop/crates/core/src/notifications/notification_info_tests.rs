use crate::NotificationInfo;

#[test]
fn serialization_omits_absent_and_empty_fields() {
    let info = NotificationInfo {
        index: 1,
        app_name: "Messages".into(),
        title: "New message".into(),
        body: None,
        actions: vec![],
    };
    let json = serde_json::to_value(&info).unwrap();
    assert!(!json.as_object().unwrap().contains_key("body"));
    assert!(!json.as_object().unwrap().contains_key("actions"));
}

#[test]
fn serialization_includes_present_fields() {
    let info = NotificationInfo {
        index: 2,
        app_name: "Slack".into(),
        title: "Channel update".into(),
        body: Some("New message in #general".into()),
        actions: vec!["Reply".into(), "Open".into()],
    };
    let json = serde_json::to_value(&info).unwrap();
    assert_eq!(json["body"], "New message in #general");
    assert_eq!(json["actions"], serde_json::json!(["Reply", "Open"]));
}
