use agent_desktop_core::{
    AdapterError, ClipboardContent, ClipboardFormat, Deadline, ErrorCode, ImageBuffer, ImageFormat,
    MAX_PNG_INPUT_BYTES,
};
use serde_json::Value;
use std::process::Command;

use super::clipboard_helper_protocol as protocol;

struct HelperResponse {
    metadata: Value,
    payload: Vec<u8>,
}

pub(crate) fn clear(deadline: Deadline) -> Result<(), AdapterError> {
    run("clear", &[], &[], deadline).map(|_| ())
}

pub(crate) fn read(
    format: ClipboardFormat,
    deadline: Deadline,
) -> Result<Option<ClipboardContent>, AdapterError> {
    let operation = format!("read:{}", format.as_str());
    let response = run(&operation, &[], &[], deadline)?;
    match response
        .metadata
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or("invalid")
    {
        "none" if response.payload.is_empty() => Ok(None),
        "text" => String::from_utf8(response.payload)
            .map(ClipboardContent::Text)
            .map(Some)
            .map_err(|_| protocol::protocol_error()),
        "file_urls" => serde_json::from_slice::<Vec<String>>(&response.payload)
            .map(ClipboardContent::FileUrls)
            .map(Some)
            .map_err(|_| protocol::protocol_error()),
        "image" => decode_image(response).map(Some),
        _ => Err(protocol::protocol_error()),
    }
}

pub(crate) fn write(content: &ClipboardContent, deadline: Deadline) -> Result<(), AdapterError> {
    match content {
        ClipboardContent::Text(text) => run("write:text", &[], text.as_bytes(), deadline),
        ClipboardContent::FileUrls(paths) => {
            let payload = serde_json::to_vec(paths)
                .map_err(|error| AdapterError::internal(format!("Encode file URLs: {error}")))?;
            run("write:file_urls", &[], &payload, deadline)
        }
        ClipboardContent::Image(image) => {
            let args = [
                image.width.to_string(),
                image.height.to_string(),
                image.scale_factor.to_string(),
            ];
            run("write:image", &args, &image.data, deadline)
        }
    }
    .map(|_| ())
}

fn decode_image(response: HelperResponse) -> Result<ClipboardContent, AdapterError> {
    let width = response
        .metadata
        .get("width")
        .and_then(Value::as_u64)
        .and_then(|value| u32::try_from(value).ok())
        .ok_or_else(protocol::protocol_error)?;
    let height = response
        .metadata
        .get("height")
        .and_then(Value::as_u64)
        .and_then(|value| u32::try_from(value).ok())
        .ok_or_else(protocol::protocol_error)?;
    Ok(ClipboardContent::Image(ImageBuffer {
        data: response.payload,
        format: ImageFormat::Png,
        width,
        height,
        scale_factor: 1.0,
    }))
}

fn run(
    operation: &str,
    args: &[String],
    input: &[u8],
    deadline: Deadline,
) -> Result<HelperResponse, AdapterError> {
    if input.len() > MAX_PNG_INPUT_BYTES {
        return Err(AdapterError::new(
            ErrorCode::InvalidArgs,
            "macOS clipboard helper input exceeds the protocol limit",
        ));
    }
    let token = random_token()?;
    let identity = super::clipboard_helper_identity::HelperIdentity::discover()?;
    let mut command = Command::new(&identity.path);
    command
        .arg(operation)
        .args(args)
        .env_clear()
        .env("AGENT_DESKTOP_MACOS_HELPER_MODE", "clipboard")
        .env(
            "AGENT_DESKTOP_MACOS_HELPER_PROTOCOL",
            protocol::PROTOCOL_VERSION,
        )
        .env("AGENT_DESKTOP_MACOS_HELPER_BUILD", protocol::BUILD_IDENTITY)
        .env("AGENT_DESKTOP_MACOS_HELPER_TOKEN", &token)
        .env("AGENT_DESKTOP_MACOS_HELPER_OUTPUT_FD", protocol::OUTPUT_FD)
        .env(
            "AGENT_DESKTOP_MACOS_HELPER_DEADLINE_MS",
            deadline.remaining_ms().to_string(),
        );
    let output =
        super::clipboard_helper_process::run(&mut command, input, deadline, Some(&identity))
            .map_err(|error| classify_mutation_failure(operation, error, false))?;
    let response = parse_output(&output, &token, operation)
        .map_err(|error| classify_mutation_failure(operation, error, true))?;
    if protocol::is_mutating(operation)
        && response.metadata.get("delivery").and_then(Value::as_str) != Some("committed_verified")
    {
        return Err(classify_mutation_failure(
            operation,
            protocol::protocol_error(),
            true,
        ));
    }
    Ok(response)
}

fn parse_output(
    output: &[u8],
    token: &str,
    operation: &str,
) -> Result<HelperResponse, AdapterError> {
    let newline = output
        .iter()
        .position(|byte| *byte == b'\n')
        .filter(|index| *index <= protocol::MAX_HEADER_BYTES)
        .ok_or_else(protocol::protocol_error)?;
    let header: Value =
        serde_json::from_slice(&output[..newline]).map_err(|_| protocol::protocol_error())?;
    let payload = output
        .get(newline + 1..)
        .ok_or_else(protocol::protocol_error)?;
    let metadata = protocol::validate_header(&header, token, operation, payload.len())?.clone();
    Ok(HelperResponse {
        metadata,
        payload: payload.to_vec(),
    })
}

fn random_token() -> Result<String, AdapterError> {
    let mut bytes = [0_u8; 32];
    if unsafe { getentropy(bytes.as_mut_ptr().cast(), bytes.len()) } != 0 {
        return Err(AdapterError::internal(format!(
            "Generate clipboard helper token: {}",
            std::io::Error::last_os_error()
        )));
    }
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn classify_mutation_failure(
    operation: &str,
    error: AdapterError,
    known_dispatched: bool,
) -> AdapterError {
    let dispatched = known_dispatched
        || error
            .details
            .as_ref()
            .and_then(|details| details.get("helper_dispatched"))
            .and_then(Value::as_bool)
            == Some(true);
    if protocol::is_mutating(operation)
        && dispatched
        && error.disposition == agent_desktop_core::DeliverySemantics::unknown()
    {
        error.with_disposition(agent_desktop_core::DeliverySemantics::uncertain())
    } else {
        error
    }
}

unsafe extern "C" {
    fn getentropy(buffer: *mut std::ffi::c_void, length: usize) -> i32;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mutation_classifier_never_marks_post_dispatch_failures_retry_safe() {
        let timeout = super::super::clipboard_helper_process::mark_dispatched(
            AdapterError::timeout("helper timed out"),
        );
        let classified = classify_mutation_failure("write:text", timeout, false);

        assert_eq!(
            classified.disposition,
            agent_desktop_core::DeliverySemantics::uncertain()
        );
        assert_eq!(
            classify_mutation_failure(
                "write:text",
                AdapterError::new(ErrorCode::InvalidArgs, "preflight")
                    .with_disposition(agent_desktop_core::DeliverySemantics::not_delivered(),),
                true,
            )
            .disposition,
            agent_desktop_core::DeliverySemantics::not_delivered()
        );
    }
}
