use serde::Serialize;
use serde_json::Value;

use crate::response::recovery_hint::RecoveryHint;
use crate::{AppError, DeliverySemantics, ErrorCode, RetryDisposition};

pub const ENVELOPE_VERSION: &str = "2.5";

/// Structured output envelope used by the CLI and future programmatic transports.
#[derive(Debug, Serialize)]
pub struct Response {
    pub version: &'static str,
    pub ok: bool,
    pub command: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<ErrorPayload>,
}

#[derive(Debug, Serialize)]
pub struct ErrorPayload {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub suggestion: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recovery: Option<RecoveryHint>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub platform_detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<Value>,
    pub disposition: DeliverySemantics,
}

impl Response {
    pub fn ok(command: impl Into<String>, data: Value) -> Self {
        Self {
            version: ENVELOPE_VERSION,
            ok: true,
            command: command.into(),
            data: Some(data),
            error: None,
        }
    }

    pub fn err(command: impl Into<String>, payload: ErrorPayload) -> Self {
        Self {
            version: ENVELOPE_VERSION,
            ok: false,
            command: command.into(),
            data: None,
            error: Some(payload),
        }
    }
}

fn recovery_for_code(
    code: &ErrorCode,
    disposition: DeliverySemantics,
    details: Option<&Value>,
) -> Option<RecoveryHint> {
    if disposition.retry() != RetryDisposition::Safe {
        return None;
    }
    let process_exited = details
        .and_then(|details| details.get("process_state"))
        .is_some_and(|state| state == "exited");
    match code {
        ErrorCode::StaleRef if process_exited => Some(RecoveryHint {
            strategy: "inspect_state_then_retry_original".into(),
            retryable: true,
            requires_fresh_snapshot: true,
            retry_after_ms: None,
        }),
        ErrorCode::StaleRef | ErrorCode::SnapshotNotFound => Some(RecoveryHint {
            strategy: "refresh_snapshot_then_retry_original".into(),
            retryable: true,
            requires_fresh_snapshot: true,
            retry_after_ms: None,
        }),
        ErrorCode::PolicyDenied => Some(RecoveryHint {
            strategy: "request_explicit_policy_then_retry_original".into(),
            retryable: true,
            requires_fresh_snapshot: false,
            retry_after_ms: None,
        }),
        ErrorCode::AppUnresponsive | ErrorCode::Timeout => Some(RecoveryHint {
            strategy: "inspect_state_then_retry_original".into(),
            retryable: true,
            requires_fresh_snapshot: true,
            retry_after_ms: Some(250),
        }),
        _ => None,
    }
}

impl ErrorPayload {
    pub fn from_app_error(err: &AppError) -> Self {
        let mut payload = Self::new(err.code(), err.to_string());
        if let Some(suggestion) = err.suggestion() {
            payload = payload.with_suggestion(suggestion);
        }
        if let AppError::Adapter(adapter_error) = err {
            payload.platform_detail = adapter_error.platform_detail.clone();
            payload.details = adapter_error.details.clone();
            payload.disposition = adapter_error.disposition;
            if adapter_error.permits_retry_by_default() {
                payload.recovery = recovery_for_code(
                    &adapter_error.code,
                    adapter_error.disposition,
                    adapter_error.details.as_ref(),
                );
            }
        }
        payload
    }

    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            suggestion: None,
            recovery: None,
            platform_detail: None,
            details: None,
            disposition: DeliverySemantics::unknown(),
        }
    }

    pub fn with_suggestion(mut self, s: impl Into<String>) -> Self {
        self.suggestion = Some(s.into());
        self
    }
}

#[cfg(test)]
#[path = "output_tests.rs"]
mod tests;
