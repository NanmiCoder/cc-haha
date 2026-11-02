use super::*;
use std::collections::HashMap;

fn valid_request() -> HelperRequest {
    (
        PermissionOperation::Accessibility,
        "ab".repeat(TOKEN_BYTES),
        42,
        "macos-proc-v1:1:2".into(),
        "/tmp/agent-desktop".into(),
    )
}

#[test]
fn partial_or_malformed_helper_environment_never_falls_through() {
    let values = HashMap::from([(OPERATION.to_string(), "accessibility".to_string())]);
    let get = |name: &str| values.get(name).cloned();

    assert!(helper_environment_present(&get));
    assert!(parse_request(&get).is_err());
}

#[test]
fn parser_accepts_only_the_closed_protocol_and_correlation_token_shape() {
    let values = HashMap::from([
        (MARKER.to_string(), PROTOCOL_VERSION.to_string()),
        (OPERATION.to_string(), "accessibility".to_string()),
        (TOKEN.to_string(), "ab".repeat(TOKEN_BYTES)),
        (PARENT_PID.to_string(), "42".to_string()),
        (PARENT_INSTANCE.to_string(), "macos-proc-v1:1:2".to_string()),
        (EXECUTABLE.to_string(), "/tmp/agent-desktop".to_string()),
    ]);

    assert!(parse_request(&|name| values.get(name).cloned()).is_ok());
    let mut invalid = values;
    invalid.insert(OPERATION.to_string(), "shell".to_string());
    assert!(parse_request(&|name| invalid.get(name).cloned()).is_err());
}

#[test]
fn detached_replayed_or_substituted_helper_invocations_are_rejected() {
    let request = valid_request();
    assert!(validate_request(&request, 41, request.4.clone(), |_, _| Ok(true)).is_err());
    assert!(validate_request(&request, 42, "/tmp/other".into(), |_, _| Ok(true)).is_err());
    assert!(validate_request(&request, 42, request.4.clone(), |_, _| Ok(false)).is_err());
}

#[test]
fn response_requires_exact_cardinality_token_and_operation() {
    let token = "cd".repeat(TOKEN_BYTES);
    let valid = json!({
        "version": 1,
        "token": token,
        "operation": "accessibility",
        "granted": true,
    });
    assert!(
        parse_response(
            valid.to_string().as_bytes(),
            PermissionOperation::Accessibility,
            &token,
        )
        .unwrap()
    );

    let wrong_token = json!({
        "version": 1,
        "token": "ef".repeat(TOKEN_BYTES),
        "operation": "accessibility",
        "granted": true,
    });
    assert!(
        parse_response(
            wrong_token.to_string().as_bytes(),
            PermissionOperation::Accessibility,
            &token,
        )
        .is_err()
    );

    let two_values = format!("{}{}", valid, valid);
    assert!(
        parse_response(
            two_values.as_bytes(),
            PermissionOperation::Accessibility,
            &token,
        )
        .is_err()
    );
    assert!(
        parse_response(
            &vec![b'x'; MAX_OUTPUT_BYTES + 1],
            PermissionOperation::Accessibility,
            &token,
        )
        .is_err()
    );
}

#[test]
fn correlation_tokens_use_full_os_random_shape() {
    let token = random_token().unwrap();

    assert!(valid_token(&token));
    assert_eq!(token.len(), TOKEN_BYTES * 2);
}
