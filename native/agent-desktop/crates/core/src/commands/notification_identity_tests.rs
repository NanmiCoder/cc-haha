use super::required_identity;

#[test]
fn empty_identity_is_rejected() {
    assert_eq!(
        required_identity(None, None).unwrap_err().code(),
        "INVALID_ARGS"
    );
    assert_eq!(
        required_identity(Some(String::new()), None)
            .unwrap_err()
            .code(),
        "INVALID_ARGS"
    );
}

#[test]
fn one_identity_field_is_sufficient() {
    assert!(required_identity(Some("Slack".into()), None).is_ok());
    assert!(required_identity(None, Some("Build finished".into())).is_ok());
}
