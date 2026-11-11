use super::ProcessId;

#[test]
fn serializes_as_a_json_number() {
    let pid = ProcessId::new(u32::MAX);

    assert_eq!(serde_json::to_string(&pid).unwrap(), u32::MAX.to_string());
    assert_eq!(
        serde_json::from_str::<ProcessId>("4294967295").unwrap(),
        pid
    );
}

#[test]
fn signed_conversion_rejects_invalid_platform_values() {
    assert!(ProcessId::try_from(-1).is_err());
    let above_pid_t = u32::try_from(i32::MAX).unwrap() + 1;
    assert!(i32::try_from(ProcessId::new(above_pid_t)).is_err());
}
