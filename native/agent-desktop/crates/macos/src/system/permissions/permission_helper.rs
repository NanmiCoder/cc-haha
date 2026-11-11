use agent_desktop_core::{AdapterError, Deadline, ErrorCode};
use serde_json::{Value, json};
use std::process::Command;

use super::permission_operation::PermissionOperation;

const MARKER: &str = "AGENT_DESKTOP_PERMISSION_HELPER";
const OPERATION: &str = "AGENT_DESKTOP_PERMISSION_OPERATION";
const TOKEN: &str = "AGENT_DESKTOP_PERMISSION_TOKEN";
const PARENT_PID: &str = "AGENT_DESKTOP_PERMISSION_PARENT_PID";
const PARENT_INSTANCE: &str = "AGENT_DESKTOP_PERMISSION_PARENT_INSTANCE";
const EXECUTABLE: &str = "AGENT_DESKTOP_PERMISSION_EXECUTABLE";
const PROTOCOL_VERSION: &str = "v1";
const TOKEN_BYTES: usize = 32;
const MAX_OUTPUT_BYTES: usize = 4 * 1024;

type HelperRequest = (PermissionOperation, String, i32, String, String);

pub fn entry_from_env() -> Option<(u8, String)> {
    let get = |name: &str| std::env::var(name).ok();
    if !helper_environment_present(&get) {
        return None;
    }
    Some(match execute_child(&get) {
        Ok(response) => (0, response.to_string()),
        Err(message) => (2, helper_error(&message).to_string()),
    })
}

pub(crate) fn request(
    operation: PermissionOperation,
    deadline: Deadline,
) -> Result<bool, AdapterError> {
    deadline.ensure_remaining()?;
    let executable = canonical_current_executable()?;
    let executable_text = executable.to_str().ok_or_else(|| {
        AdapterError::internal("Permission helper executable path is not valid UTF-8")
    })?;
    let parent_pid = i32::try_from(std::process::id())
        .map_err(|_| AdapterError::internal("Permission helper parent PID is out of range"))?;
    let parent_instance = crate::system::process::process_identity::token_for_pid(parent_pid)?
        .ok_or_else(|| AdapterError::internal("Permission helper parent identity disappeared"))?;
    let correlation_token = random_token()?;
    let mut command = Command::new(&executable);
    command
        .env(MARKER, PROTOCOL_VERSION)
        .env(OPERATION, operation.as_str())
        .env(TOKEN, &correlation_token)
        .env(PARENT_PID, parent_pid.to_string())
        .env(PARENT_INSTANCE, parent_instance)
        .env(EXECUTABLE, executable_text);
    let output = crate::system::process::run_with_deadline(
        &mut command,
        "macOS permission prompt helper",
        deadline_instant(deadline)?,
    )?;
    if !output.status.success() {
        return Err(AdapterError::new(
            ErrorCode::AppUnresponsive,
            "macOS permission prompt helper rejected its invocation",
        )
        .with_platform_detail(bounded_text(&output.stderr))
        .with_details(json!({
            "kind": "permission_prompt_helper",
            "exit_code": output.status.code(),
            "complete": false,
        })));
    }
    parse_response(&output.stdout, operation, &correlation_token)
}

fn execute_child(get: &impl Fn(&str) -> Option<String>) -> Result<Value, String> {
    let request = parse_request(get)?;
    validate_request(
        &request,
        unsafe { libc::getppid() },
        canonical_current_executable_text()?,
        crate::system::process::process_identity::matches_instance,
    )?;
    let granted = match request.0 {
        PermissionOperation::Accessibility => {
            crate::system::permissions::prompt_accessibility();
            crate::system::permissions::preflight_accessibility()
        }
        PermissionOperation::ScreenRecording => {
            crate::system::permissions::prompt_screen_recording();
            crate::system::permissions::preflight_screen_recording()
        }
        PermissionOperation::Automation => crate::system::permissions::prompt_automation(),
    };
    Ok(json!({
        "version": 1,
        "token": request.1,
        "operation": request.0.as_str(),
        "granted": granted,
    }))
}

fn helper_environment_present(get: &impl Fn(&str) -> Option<String>) -> bool {
    [
        MARKER,
        OPERATION,
        TOKEN,
        PARENT_PID,
        PARENT_INSTANCE,
        EXECUTABLE,
    ]
    .into_iter()
    .any(|name| get(name).is_some())
}

fn parse_request(get: &impl Fn(&str) -> Option<String>) -> Result<HelperRequest, String> {
    if get(MARKER).as_deref() != Some(PROTOCOL_VERSION) {
        return Err("invalid permission helper protocol marker".into());
    }
    let operation = get(OPERATION)
        .as_deref()
        .and_then(PermissionOperation::parse)
        .ok_or_else(|| "invalid permission helper operation".to_string())?;
    let token = get(TOKEN)
        .filter(|value| valid_token(value))
        .ok_or_else(|| "invalid permission helper correlation token".to_string())?;
    let parent_pid = get(PARENT_PID)
        .and_then(|value| value.parse::<i32>().ok())
        .filter(|pid| *pid > 0)
        .ok_or_else(|| "invalid permission helper parent PID".to_string())?;
    let parent_instance = get(PARENT_INSTANCE)
        .filter(|value| !value.is_empty() && value.len() <= 128)
        .ok_or_else(|| "invalid permission helper parent identity".to_string())?;
    let executable = get(EXECUTABLE)
        .filter(|value| !value.is_empty() && value.len() <= 16 * 1024)
        .ok_or_else(|| "invalid permission helper executable".to_string())?;
    Ok((operation, token, parent_pid, parent_instance, executable))
}

fn validate_request(
    request: &HelperRequest,
    actual_parent: i32,
    actual_executable: String,
    matches_parent: impl FnOnce(i32, &str) -> Result<bool, AdapterError>,
) -> Result<(), String> {
    if request.2 != actual_parent {
        return Err("permission helper is detached from its requesting parent".into());
    }
    if request.4 != actual_executable {
        return Err("permission helper executable identity mismatch".into());
    }
    match matches_parent(request.2, &request.3) {
        Ok(true) => Ok(()),
        Ok(false) => Err("permission helper parent process instance changed".into()),
        Err(error) => Err(format!(
            "permission helper parent validation failed: {error}"
        )),
    }
}

fn parse_response(
    bytes: &[u8],
    expected_operation: PermissionOperation,
    expected_token: &str,
) -> Result<bool, AdapterError> {
    if bytes.len() > MAX_OUTPUT_BYTES {
        return Err(response_error("response exceeded the protocol size limit"));
    }
    let response: Value = serde_json::from_slice(bytes)
        .map_err(|_| response_error("response was not exactly one JSON value"))?;
    let object = response
        .as_object()
        .filter(|object| object.len() == 4)
        .ok_or_else(|| response_error("response had an invalid field set"))?;
    if object.get("version").and_then(Value::as_u64) != Some(1)
        || object.get("token").and_then(Value::as_str) != Some(expected_token)
        || object.get("operation").and_then(Value::as_str) != Some(expected_operation.as_str())
    {
        return Err(response_error(
            "response identity did not match the request",
        ));
    }
    object
        .get("granted")
        .and_then(Value::as_bool)
        .ok_or_else(|| response_error("response omitted the diagnostic grant state"))
}

fn random_token() -> Result<String, AdapterError> {
    let mut bytes = [0_u8; TOKEN_BYTES];
    let result = unsafe { getentropy(bytes.as_mut_ptr().cast(), bytes.len()) };
    if result != 0 {
        return Err(AdapterError::internal(format!(
            "Could not create permission helper correlation token: {}",
            std::io::Error::last_os_error()
        )));
    }
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn valid_token(value: &str) -> bool {
    value.len() == TOKEN_BYTES * 2
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn canonical_current_executable() -> Result<std::path::PathBuf, AdapterError> {
    std::env::current_exe()
        .and_then(std::fs::canonicalize)
        .map_err(|error| AdapterError::internal(format!("Resolve current executable: {error}")))
}

fn canonical_current_executable_text() -> Result<String, String> {
    canonical_current_executable()
        .map_err(|error| error.to_string())?
        .into_os_string()
        .into_string()
        .map_err(|_| "permission helper executable path is not valid UTF-8".into())
}

fn deadline_instant(deadline: Deadline) -> Result<std::time::Instant, AdapterError> {
    std::time::Instant::now()
        .checked_add(deadline.remaining())
        .ok_or_else(|| AdapterError::internal("Permission helper deadline is out of range"))
}

fn response_error(reason: &str) -> AdapterError {
    AdapterError::new(
        ErrorCode::AppUnresponsive,
        "macOS permission prompt helper returned an invalid response",
    )
    .with_platform_detail(reason)
    .with_details(json!({ "kind": "permission_prompt_helper", "complete": false }))
}

fn helper_error(message: &str) -> Value {
    json!({
        "version": 1,
        "ok": false,
        "error": "invalid_helper_invocation",
        "message": message,
    })
}

fn bounded_text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(&bytes[..bytes.len().min(MAX_OUTPUT_BYTES)]).into_owned()
}

unsafe extern "C" {
    fn getentropy(buffer: *mut std::ffi::c_void, size: usize) -> i32;
}

#[cfg(test)]
#[path = "permission_helper_tests.rs"]
mod tests;
