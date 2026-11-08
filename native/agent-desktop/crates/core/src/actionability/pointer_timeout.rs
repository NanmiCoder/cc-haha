use serde_json::{Value, json};

use crate::AppError;

pub(crate) fn point_actionability_timeout(last_report: Option<Value>) -> AppError {
    if let Some(error) = last_report.as_ref().and_then(settled_point_identity) {
        return error.into();
    }
    let mut details = json!({ "kind": "actionability_timeout" });
    if let Some(last_report) = last_report
        && let Some(object) = details.as_object_mut()
    {
        object.insert("last_report".into(), last_report);
    }
    crate::AdapterError::timeout("Pointer target did not become actionable within the wait budget")
        .with_details(details)
        .with_disposition(crate::DeliverySemantics::not_delivered())
        .into()
}

fn settled_point_identity(report: &Value) -> Option<crate::AdapterError> {
    let details = report.get("details").filter(|details| !details.is_null())?;
    if details.get("complete").and_then(Value::as_bool) != Some(true) {
        return None;
    }
    let message = report.get("message").and_then(Value::as_str)?;
    let error = match report.get("code").and_then(Value::as_str)? {
        "STALE_REF" => crate::AdapterError::stale_ref_because(message),
        "AMBIGUOUS_TARGET" => crate::AdapterError::ambiguous_target(message),
        _ => return None,
    };
    Some(
        error
            .with_details(details.clone())
            .with_disposition(crate::DeliverySemantics::not_delivered()),
    )
}

#[cfg(test)]
#[path = "pointer_timeout_tests.rs"]
mod tests;
