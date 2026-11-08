use agent_desktop_core::{
    AdapterError, AppError, DeliverySemantics, ErrorCode,
    response::output::{ENVELOPE_VERSION, ErrorPayload},
};
use serde_json::{Value, json};

use super::bounded_json::serialized_fits;

pub(super) const MAX_BATCH_OUTPUT_BYTES: usize = 4 * 1024 * 1024;
pub(super) const OUTPUT_METADATA_RESERVE: usize = 8 * 1024;

#[cfg(test)]
pub(super) fn bounded_entry(
    index: usize,
    command: &str,
    result: Result<Value, AppError>,
    used: usize,
) -> (Value, bool) {
    let entry = completed_entry(index, command, result);
    bounded_completed_entry(index, command, entry, used)
}

pub(super) fn bounded_completed_entry(
    index: usize,
    command: &str,
    entry: Value,
    used: usize,
) -> (Value, bool) {
    let available = MAX_BATCH_OUTPUT_BYTES
        .saturating_sub(OUTPUT_METADATA_RESERVE)
        .saturating_sub(used);
    if serialized_fits(&entry, available) {
        return (entry, false);
    }
    let disposition = entry_disposition(&entry);
    let error = AdapterError::new(
        ErrorCode::InvalidArgs,
        "Batch entry completed but its result exceeded the response limit",
    )
    .with_suggestion("Split the batch or narrow commands that return large payloads")
    .with_details(json!({
        "batch_index": index,
        "max_output_bytes": MAX_BATCH_OUTPUT_BYTES,
        "result_omitted": true,
    }))
    .with_disposition(disposition)
    .into();
    (completed_entry(index, command, Err(error)), true)
}

pub(super) fn completed_entry(
    index: usize,
    command: &str,
    result: Result<Value, AppError>,
) -> Value {
    match result {
        Ok(data) => json!({
            "version": ENVELOPE_VERSION,
            "ok": true,
            "command": command,
            "index": index,
            "execution": "completed",
            "data": data,
        }),
        Err(error) => json!({
            "version": ENVELOPE_VERSION,
            "ok": false,
            "command": command,
            "index": index,
            "execution": "completed",
            "error": ErrorPayload::from_app_error(&error),
        }),
    }
}

pub(super) fn not_started_entry(
    index: usize,
    command: &str,
    reason: &str,
    error: AppError,
) -> Value {
    json!({
        "version": ENVELOPE_VERSION,
        "ok": false,
        "command": command,
        "index": index,
        "execution": "not_started",
        "not_started_reason": reason,
        "error": ErrorPayload::from_app_error(&error),
    })
}

fn entry_disposition(entry: &Value) -> DeliverySemantics {
    let disposition = entry
        .get("data")
        .and_then(|data| data.get("disposition"))
        .or_else(|| {
            entry
                .get("error")
                .and_then(|error| error.get("disposition"))
        });
    disposition
        .cloned()
        .and_then(|value| serde_json::from_value(value).ok())
        .unwrap_or_else(DeliverySemantics::uncertain)
}
