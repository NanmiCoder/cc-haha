use crate::{AdapterError, AppError, ErrorCode, commands::wait_predicate};
use serde_json::{Value, json};

/// Whether an error is the wait's own deadline expiring inside an adapter
/// call, rather than evidence about the target. Such an error ends the wait
/// with the wait's timeout shape instead of being polled past or remembered
/// as the cause.
pub(crate) fn is_deadline_expired(error: &AdapterError) -> bool {
    error.code == ErrorCode::Timeout
        && error
            .details
            .as_ref()
            .and_then(|details| details.get("kind"))
            .and_then(Value::as_str)
            == Some("deadline")
}

pub(crate) fn menu(mut error: AdapterError, timeout_ms: u64) -> AppError {
    if error.code == ErrorCode::Timeout {
        let details = error.details.get_or_insert_with(|| json!({}));
        if !details.is_object() {
            *details = json!({ "adapter_details": details.take() });
        }
        details["kind"] = json!("wait_timeout");
        details["predicate"] = json!("menu");
        details["timeout_ms"] = json!(timeout_ms);
    }
    AppError::Adapter(error)
}

/// Builds the wait-loop TIMEOUT error. Every payload carries
/// `kind: "wait_timeout"` so agents can discriminate it from the chain
/// deadline TIMEOUT schema (`kind: "chain_deadline"`) without sniffing
/// field names.
fn timeout_err(message: String, mut details: Value) -> Result<Value, AppError> {
    details["kind"] = json!("wait_timeout");
    Err(AppError::Adapter(
        AdapterError::timeout(message).with_details(details),
    ))
}

pub(crate) fn element(
    ref_id: String,
    predicate: wait_predicate::ElementPredicate,
    timeout_ms: u64,
    last_observed: Value,
) -> Result<Value, AppError> {
    timeout_err(
        format!(
            "Element {ref_id} did not satisfy predicate '{}' within {timeout_ms}ms",
            predicate.name()
        ),
        json!({
            "ref": ref_id,
            "predicate": predicate.name(),
            "timeout_ms": timeout_ms,
            "last_observed": last_observed
        }),
    )
}

fn with_last_error(mut details: Value, last_error: Option<Value>) -> Value {
    if let Some(err) = last_error {
        details["last_error"] = err;
    }
    details
}

pub(crate) fn window(
    title: &str,
    app: Option<&str>,
    timeout_ms: u64,
    last_error: Option<Value>,
    last_observed: Option<Value>,
) -> Result<Value, AppError> {
    let mut details = json!({
        "predicate": "window",
        "title": title,
        "timeout_ms": timeout_ms,
    });
    if let Some(app) = app {
        details["app"] = json!(app);
    }
    if let Some(last_observed) = last_observed {
        details["last_observed"] = last_observed;
    }
    timeout_err(
        format!(
            "Window title ({} chars) not found within {timeout_ms}ms",
            title.chars().count()
        ),
        with_last_error(details, last_error),
    )
}

pub(crate) fn window_observation(windows: &[crate::WindowInfo]) -> Value {
    json!({
        "count": windows.len(),
        "titles": windows.iter().take(8)
            .map(|window| window.title.chars().take(120).collect::<String>())
            .collect::<Vec<_>>(),
        "truncated": windows.len() > 8 || windows.iter().take(8)
            .any(|window| window.title.chars().nth(120).is_some()),
    })
}

pub(crate) fn text(
    text: &str,
    timeout_ms: u64,
    expected_count: Option<usize>,
    last_error: Option<Value>,
) -> Result<Value, AppError> {
    timeout_err(
        format!(
            "Text ({} chars) did not match within {timeout_ms}ms",
            text.chars().count()
        ),
        with_last_error(
            json!({
                "predicate": "text",
                "text_chars": text.chars().count(),
                "timeout_ms": timeout_ms,
                "expected_count": expected_count,
            }),
            last_error,
        ),
    )
}

pub(crate) fn notification(
    app: Option<&String>,
    text: Option<&String>,
    timeout_ms: u64,
    last_error: Option<Value>,
) -> Result<Value, AppError> {
    timeout_err(
        format!("No new notification within {timeout_ms}ms"),
        with_last_error(
            json!({
                "predicate": "notification",
                "timeout_ms": timeout_ms,
                "app": app,
                "text_chars": text.map(|text| text.chars().count()),
            }),
            last_error,
        ),
    )
}

pub(crate) fn selector(
    selector: &str,
    gone: bool,
    timeout_ms: u64,
    last_error: Option<Value>,
    last_snapshot_id: Option<String>,
) -> Result<Value, AppError> {
    let mut details = with_last_error(
        json!({
            "predicate": "selector",
            "selector": selector,
            "gone": gone,
            "timeout_ms": timeout_ms,
        }),
        last_error,
    );
    if let Some(snapshot_id) = last_snapshot_id {
        details["snapshot_id"] = json!(snapshot_id);
    }
    timeout_err(
        format!(
            "Selector ({} chars) did not {} within {timeout_ms}ms",
            selector.chars().count(),
            if gone { "disappear" } else { "appear" }
        ),
        details,
    )
}

#[cfg(test)]
#[path = "wait_timeout_tests.rs"]
mod tests;
