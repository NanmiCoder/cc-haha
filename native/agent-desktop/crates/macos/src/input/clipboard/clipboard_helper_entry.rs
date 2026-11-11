use agent_desktop_core::{
    AdapterError, ClipboardContent, ClipboardFormat, Deadline, ErrorCode, ImageBuffer, ImageFormat,
    MAX_PNG_INPUT_BYTES,
};
use serde_json::{Value, json};
use std::io::{Read, Write};
use std::os::fd::FromRawFd;

use super::clipboard_helper_protocol as protocol;

pub fn entry_from_env() -> i32 {
    let Some(context) = protocol_context() else {
        return 2;
    };
    let mut output = unsafe { std::fs::File::from_raw_fd(1) };
    let result = execute(&context.operation, &context.args, context.deadline);
    let (header, payload) = match result {
        Ok((metadata, payload)) => (
            protocol::response_header(
                &context.token,
                &context.operation,
                Ok((metadata, payload.len())),
            ),
            payload,
        ),
        Err(error) => {
            let error = classify_operation_error(&context.operation, error);
            (
                protocol::response_header(&context.token, &context.operation, Err(&error)),
                Vec::new(),
            )
        }
    };
    if write_response(&mut output, &header, &payload).is_err() {
        return 3;
    }
    if header.get("ok").and_then(Value::as_bool) == Some(true) {
        0
    } else {
        1
    }
}

fn classify_operation_error(operation: &str, error: AdapterError) -> AdapterError {
    if protocol::is_mutating(operation)
        && error.disposition == agent_desktop_core::DeliverySemantics::unknown()
    {
        error.with_disposition(agent_desktop_core::DeliverySemantics::not_delivered())
    } else {
        error
    }
}

struct ProtocolContext {
    token: String,
    operation: String,
    args: Vec<String>,
    deadline: Deadline,
}

fn protocol_context() -> Option<ProtocolContext> {
    let exact = [
        ("AGENT_DESKTOP_MACOS_HELPER_MODE", "clipboard"),
        (
            "AGENT_DESKTOP_MACOS_HELPER_PROTOCOL",
            protocol::PROTOCOL_VERSION,
        ),
        ("AGENT_DESKTOP_MACOS_HELPER_BUILD", protocol::BUILD_IDENTITY),
        ("AGENT_DESKTOP_MACOS_HELPER_OUTPUT_FD", protocol::OUTPUT_FD),
    ];
    if exact
        .iter()
        .any(|(key, value)| std::env::var(key).as_deref() != Ok(*value))
    {
        return None;
    }
    let token = std::env::var("AGENT_DESKTOP_MACOS_HELPER_TOKEN").ok()?;
    if token.len() != 64 || !token.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    let timeout_ms = std::env::var("AGENT_DESKTOP_MACOS_HELPER_DEADLINE_MS")
        .ok()?
        .parse::<u64>()
        .ok()?
        .clamp(1, 60_000);
    let mut args = std::env::args().skip(1);
    let operation = args.next()?;
    Some(ProtocolContext {
        token,
        operation,
        args: args.collect(),
        deadline: Deadline::after(timeout_ms).ok()?,
    })
}

fn execute(
    operation: &str,
    args: &[String],
    deadline: Deadline,
) -> Result<(Value, Vec<u8>), AdapterError> {
    match operation {
        "clear" if args.is_empty() => {
            super::clear_direct(deadline)?;
            Ok((
                json!({ "kind": "none", "delivery": "committed_verified" }),
                Vec::new(),
            ))
        }
        "read:auto" | "read:text" | "read:image" | "read:file_urls" if args.is_empty() => {
            let format = match operation {
                "read:auto" => ClipboardFormat::Auto,
                "read:text" => ClipboardFormat::Text,
                "read:image" => ClipboardFormat::Image,
                _ => ClipboardFormat::FileUrls,
            };
            encode_content(super::get_content_direct(format, deadline)?)
        }
        "write:text" if args.is_empty() => {
            let input = read_input(MAX_PNG_INPUT_BYTES)?;
            let text = String::from_utf8(input).map_err(|_| {
                AdapterError::new(ErrorCode::InvalidArgs, "Clipboard text must be valid UTF-8")
            })?;
            super::set_content_direct(&ClipboardContent::Text(text), deadline)?;
            Ok((
                json!({ "kind": "none", "delivery": "committed_verified" }),
                Vec::new(),
            ))
        }
        "write:file_urls" if args.is_empty() => {
            let input = read_input(MAX_PNG_INPUT_BYTES)?;
            let paths = serde_json::from_slice::<Vec<String>>(&input).map_err(|_| {
                AdapterError::new(ErrorCode::InvalidArgs, "Invalid clipboard file URL request")
            })?;
            super::set_content_direct(&ClipboardContent::FileUrls(paths), deadline)?;
            Ok((
                json!({ "kind": "none", "delivery": "committed_verified" }),
                Vec::new(),
            ))
        }
        "write:image" if args.len() == 3 => {
            let width = parse_arg::<u32>(&args[0], "width")?;
            let height = parse_arg::<u32>(&args[1], "height")?;
            let scale_factor = parse_arg::<f64>(&args[2], "scale factor")?;
            let image = ClipboardContent::Image(ImageBuffer {
                data: read_input(MAX_PNG_INPUT_BYTES)?,
                format: ImageFormat::Png,
                width,
                height,
                scale_factor,
            });
            super::set_content_direct(&image, deadline)?;
            Ok((
                json!({ "kind": "none", "delivery": "committed_verified" }),
                Vec::new(),
            ))
        }
        "validate:png" if args.is_empty() => {
            let input = read_input(MAX_PNG_INPUT_BYTES)?;
            if !super::clipboard_image_io::is_complete_png(&input) {
                return Err(AdapterError::new(
                    ErrorCode::InvalidArgs,
                    "Clipboard PNG failed platform validation",
                ));
            }
            Ok((json!({ "kind": "none" }), Vec::new()))
        }
        _ => Err(AdapterError::new(
            ErrorCode::InvalidArgs,
            "Unsupported macOS clipboard helper operation",
        )),
    }
}

fn encode_content(content: Option<ClipboardContent>) -> Result<(Value, Vec<u8>), AdapterError> {
    match content {
        None => Ok((json!({ "kind": "none" }), Vec::new())),
        Some(ClipboardContent::Text(text)) => Ok((json!({ "kind": "text" }), text.into_bytes())),
        Some(ClipboardContent::FileUrls(paths)) => Ok((
            json!({ "kind": "file_urls" }),
            serde_json::to_vec(&paths)
                .map_err(|error| AdapterError::internal(format!("Encode file URLs: {error}")))?,
        )),
        Some(ClipboardContent::Image(image)) => Ok((
            json!({
                "kind": "image",
                "width": image.width,
                "height": image.height,
            }),
            image.data,
        )),
    }
}

fn read_input(limit: usize) -> Result<Vec<u8>, AdapterError> {
    let mut input = Vec::new();
    std::io::stdin()
        .take((limit + 1) as u64)
        .read_to_end(&mut input)
        .map_err(|error| AdapterError::internal(format!("Read helper request: {error}")))?;
    if input.len() > limit {
        return Err(AdapterError::new(
            ErrorCode::InvalidArgs,
            "Clipboard helper request exceeds the protocol limit",
        ));
    }
    Ok(input)
}

fn parse_arg<T: std::str::FromStr>(value: &str, name: &str) -> Result<T, AdapterError> {
    value
        .parse()
        .map_err(|_| AdapterError::new(ErrorCode::InvalidArgs, format!("Invalid image {name}")))
}

fn write_response(
    output: &mut std::fs::File,
    header: &Value,
    payload: &[u8],
) -> std::io::Result<()> {
    let encoded = serde_json::to_vec(header).map_err(std::io::Error::other)?;
    if encoded.len() > protocol::MAX_HEADER_BYTES || payload.len() > protocol::MAX_RESPONSE_BYTES {
        return Err(std::io::Error::other(
            "clipboard helper response exceeds limit",
        ));
    }
    output.write_all(&encoded)?;
    output.write_all(b"\n")?;
    output.write_all(payload)?;
    output.flush()
}
