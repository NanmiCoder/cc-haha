use agent_desktop_core::{AdapterError, ErrorCode};
use serde_json::{Value, json};

pub(crate) const HELPER_BASENAME: &str = "agent-desktop-macos-helper";
pub(crate) const PROTOCOL_VERSION: &str = "1";
pub(crate) const BUILD_IDENTITY: &str = env!("AGENT_DESKTOP_MACOS_HELPER_BUILD_ID");
pub(crate) const OUTPUT_FD: &str = "1";
pub(crate) const MAX_HEADER_BYTES: usize = 16 * 1024;
pub(crate) const MAX_RESPONSE_BYTES: usize =
    agent_desktop_core::MAX_PNG_INPUT_BYTES + MAX_HEADER_BYTES;

pub(crate) fn is_mutating(operation: &str) -> bool {
    operation == "clear" || operation.starts_with("write:")
}

pub(crate) fn response_header(
    token: &str,
    operation: &str,
    result: Result<(Value, usize), &AdapterError>,
) -> Value {
    match result {
        Ok((metadata, payload_len)) => json!({
            "protocol": PROTOCOL_VERSION,
            "build": BUILD_IDENTITY,
            "token": token,
            "operation": operation,
            "ok": true,
            "payload_len": payload_len,
            "metadata": metadata,
        }),
        Err(error) => json!({
            "protocol": PROTOCOL_VERSION,
            "build": BUILD_IDENTITY,
            "token": token,
            "operation": operation,
            "ok": false,
            "payload_len": 0,
            "error_code": error.code.as_str(),
            "message": error.message,
            "disposition": error.disposition,
        }),
    }
}

pub(crate) fn validate_header<'a>(
    header: &'a Value,
    token: &str,
    operation: &str,
    payload_len: usize,
) -> Result<&'a Value, AdapterError> {
    let object = header.as_object().ok_or_else(protocol_error)?;
    let expected = [
        ("protocol", PROTOCOL_VERSION),
        ("build", BUILD_IDENTITY),
        ("token", token),
        ("operation", operation),
    ];
    if expected
        .iter()
        .any(|(key, value)| object.get(*key).and_then(Value::as_str) != Some(*value))
    {
        return Err(protocol_error());
    }
    let declared = object
        .get("payload_len")
        .and_then(Value::as_u64)
        .and_then(|value| usize::try_from(value).ok())
        .ok_or_else(protocol_error)?;
    if declared != payload_len || declared > MAX_RESPONSE_BYTES {
        return Err(protocol_error());
    }
    if object.get("ok").and_then(Value::as_bool) == Some(true) {
        return object.get("metadata").ok_or_else(protocol_error);
    }
    let code = object
        .get("error_code")
        .and_then(Value::as_str)
        .map(error_code)
        .unwrap_or(ErrorCode::ActionFailed);
    let message = object
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("macOS clipboard helper failed");
    let disposition = object
        .get("disposition")
        .cloned()
        .and_then(|value| serde_json::from_value(value).ok())
        .unwrap_or_else(agent_desktop_core::DeliverySemantics::unknown);
    Err(AdapterError::new(code, message).with_disposition(disposition))
}

pub(crate) fn error_code(code: &str) -> ErrorCode {
    match code {
        "PERM_DENIED" => ErrorCode::PermDenied,
        "INVALID_ARGS" => ErrorCode::InvalidArgs,
        "TIMEOUT" => ErrorCode::Timeout,
        "APP_UNRESPONSIVE" => ErrorCode::AppUnresponsive,
        "ACTION_NOT_SUPPORTED" => ErrorCode::ActionNotSupported,
        _ => ErrorCode::ActionFailed,
    }
}

pub(crate) fn protocol_error() -> AdapterError {
    AdapterError::new(
        ErrorCode::AppUnresponsive,
        "macOS clipboard helper returned an invalid authenticated response",
    )
    .with_details(json!({
        "kind": "clipboard_helper_protocol",
        "complete": false,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn protocol_rejects_wrong_token_version_and_build() {
        let valid = response_header("token", "read:text", Ok((json!({}), 0)));
        assert!(validate_header(&valid, "token", "read:text", 0).is_ok());
        for field in ["token", "protocol", "build"] {
            let mut invalid = valid.clone();
            invalid[field] = Value::String("wrong".into());
            assert!(validate_header(&invalid, "token", "read:text", 0).is_err());
        }
    }

    #[test]
    fn protocol_rejects_trailing_or_missing_payload() {
        let header = response_header("token", "read:image", Ok((json!({}), 7)));

        assert!(validate_header(&header, "token", "read:image", 6).is_err());
        assert!(validate_header(&header, "token", "read:image", 8).is_err());
    }
}
