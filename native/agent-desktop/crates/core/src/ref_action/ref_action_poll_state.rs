use serde_json::{Value, json};

use crate::{ActionResult, AdapterError, ErrorCode, actionability::StabilityExpectation};

#[derive(Default)]
pub(crate) struct RefActionPollState {
    pub(crate) last_report: Option<Value>,
    pub(crate) last_settled_identity_error: Option<AdapterError>,
    pub(crate) saw_ambiguity: bool,
    pub(crate) expected_bounds_hash: Option<u64>,
    pub(crate) resolve_attempts: u64,
    pub(crate) preflight_attempts: u64,
    pub(crate) live_read_incomplete_only: Option<bool>,
}

impl RefActionPollState {
    pub(crate) fn stability(&self) -> StabilityExpectation {
        StabilityExpectation::strict_hash(self.expected_bounds_hash)
    }

    pub(crate) fn record_preflight_error(&mut self, error: &AdapterError) {
        self.live_read_incomplete_only =
            Some(self.live_read_incomplete_only.unwrap_or(true) && is_live_read_incomplete(error));
        if let Some(observed) =
            crate::ref_action::ref_action_wait_evidence::observed_bounds_hash(error)
        {
            self.expected_bounds_hash = Some(observed);
        }
        if let Some(report) = error.details.clone() {
            self.last_report = Some(json!({ "phase": "preflight", "report": report }));
        }
    }

    pub(crate) fn record_resolve_error(&mut self, error: &AdapterError) {
        self.live_read_incomplete_only = Some(false);
        if is_settled_identity(error) {
            self.last_settled_identity_error = Some(error.clone());
        }
        self.last_report = Some(json!({
            "phase": "resolve",
            "code": error.code.as_str(),
            "message": error.message,
            "details": error.details,
        }));
    }

    pub(crate) fn note_resolved(&mut self) {
        self.last_settled_identity_error = None;
    }

    pub(crate) fn settled_identity_error(&self) -> Option<&AdapterError> {
        self.last_settled_identity_error.as_ref()
    }

    pub(crate) fn only_live_read_incomplete(&self) -> bool {
        self.live_read_incomplete_only == Some(true)
    }

    pub(crate) fn attach_transient_ambiguity(&self, result: &mut ActionResult) {
        if !self.saw_ambiguity {
            return;
        }
        let mut details = result.details.take().unwrap_or_else(|| json!({}));
        if let Some(object) = details.as_object_mut() {
            object.insert("transient_ambiguity".into(), json!(true));
            result.details = Some(details);
        } else {
            result.details = Some(json!({
                "action_details": details,
                "transient_ambiguity": true,
            }));
        }
    }

    pub(crate) fn attach_wait_metrics(
        &self,
        result: &mut ActionResult,
        lease: &crate::InteractionLease,
        lease_hold_ms: u64,
    ) {
        let mut details = result.details.take().unwrap_or_else(|| json!({}));
        let metrics = json!({
            "read_only_resolve_attempts": self.resolve_attempts,
            "read_only_preflight_attempts": self.preflight_attempts,
            "lease_contention_count": lease.contention_count(),
            "lease_hold_ms": lease_hold_ms,
        });
        if let Some(object) = details.as_object_mut() {
            object.insert("auto_wait".into(), metrics);
            result.details = Some(details);
        } else {
            result.details = Some(json!({
                "action_details": details,
                "auto_wait": metrics,
            }));
        }
    }

    pub(crate) fn attach_error_metrics(&self, mut error: AdapterError) -> AdapterError {
        let mut details = error.details.take().unwrap_or_else(|| json!({}));
        let metrics = json!({
            "read_only_resolve_attempts": self.resolve_attempts,
            "read_only_preflight_attempts": self.preflight_attempts,
        });
        if let Some(object) = details.as_object_mut() {
            object.insert("auto_wait".into(), metrics);
            error.details = Some(details);
        } else {
            error.details = Some(json!({
                "error_details": details,
                "auto_wait": metrics,
            }));
        }
        error
    }
}

fn is_settled_identity(error: &AdapterError) -> bool {
    matches!(error.code, ErrorCode::StaleRef | ErrorCode::AmbiguousTarget)
        && error
            .details
            .as_ref()
            .and_then(|details| details.get("complete"))
            .and_then(Value::as_bool)
            == Some(true)
}

fn is_live_read_incomplete(error: &AdapterError) -> bool {
    error.details.as_ref().is_some_and(|details| {
        details.get("kind").and_then(Value::as_str) == Some("live_element_evidence")
            && details.get("complete").and_then(Value::as_bool) == Some(false)
    })
}
