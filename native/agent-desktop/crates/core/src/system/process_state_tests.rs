use super::*;

#[test]
fn label_reports_short_lowercase_tag_per_variant() {
    assert_eq!(ProcessState::Running.label(), "running");
    assert_eq!(ProcessState::Exited { code: None }.label(), "exited");
    assert_eq!(ProcessState::Exited { code: Some(1) }.label(), "exited");
    assert_eq!(
        ProcessState::Crashed { signal_or_code: 11 }.label(),
        "crashed"
    );
    assert_eq!(ProcessState::Unresponsive.label(), "unresponsive");
}

#[test]
fn exited_serializes_with_optional_code_field() {
    let value = serde_json::to_value(ProcessState::Exited { code: None }).expect("serializable");
    assert_eq!(value, serde_json::json!({ "state": "exited" }));

    let value = serde_json::to_value(ProcessState::Exited { code: Some(9) }).expect("serializable");
    assert_eq!(value, serde_json::json!({ "state": "exited", "code": 9 }));

    let value = serde_json::to_value(ProcessState::Exited { code: Some(0) }).expect("serializable");
    assert_eq!(value, serde_json::json!({ "state": "exited", "code": 0 }));
}

#[test]
fn crashed_round_trips_through_serde() {
    let value =
        serde_json::to_value(ProcessState::Crashed { signal_or_code: 11 }).expect("serializable");
    assert_eq!(
        value,
        serde_json::json!({ "state": "crashed", "signal_or_code": 11 })
    );

    let round_tripped: ProcessState = serde_json::from_value(value).expect("deserializable");
    assert_eq!(round_tripped, ProcessState::Crashed { signal_or_code: 11 });

    let access_violation = 0xC000_0005u32 as i32;
    let value = serde_json::to_value(ProcessState::Crashed {
        signal_or_code: access_violation,
    })
    .expect("serializable");
    assert_eq!(
        value,
        serde_json::json!({ "state": "crashed", "signal_or_code": access_violation })
    );
}

#[test]
fn running_and_unresponsive_serialize_as_tag_only() {
    assert_eq!(
        serde_json::to_value(ProcessState::Running).expect("serializable"),
        serde_json::json!({ "state": "running" })
    );
    assert_eq!(
        serde_json::to_value(ProcessState::Unresponsive).expect("serializable"),
        serde_json::json!({ "state": "unresponsive" })
    );
}
