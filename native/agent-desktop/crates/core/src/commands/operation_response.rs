use crate::{AppError, DeliverySemantics, OperationReport};
use serde_json::{Map, Value};

pub(crate) fn operation_response(
    report: &OperationReport,
    request: Value,
) -> Result<Value, AppError> {
    let mut response = serde_json::to_value(report).map_err(|error| {
        AppError::Adapter(
            crate::AdapterError::internal(format!(
                "operation report could not be encoded: {error}"
            ))
            .with_disposition(report.disposition()),
        )
    })?;
    if let (Some(body), Value::Object(fields)) = (response.as_object_mut(), request) {
        merge_request_fields(body, fields);
    }
    Ok(response)
}

fn merge_request_fields(body: &mut Map<String, Value>, fields: Map<String, Value>) {
    for (key, value) in fields {
        body.entry(key).or_insert(value);
    }
}

pub(crate) fn delivery_in(value: &Value) -> DeliverySemantics {
    let reported = value.get("disposition").and_then(|disposition| {
        serde_json::from_value::<DeliverySemantics>(disposition.clone()).ok()
    });
    match reported {
        Some(
            disposition @ (DeliverySemantics::NotDelivered | DeliverySemantics::DeliveredVerified),
        ) => disposition,
        _ => DeliverySemantics::delivered_unverified(),
    }
}

#[cfg(test)]
#[path = "operation_response_tests.rs"]
mod tests;
