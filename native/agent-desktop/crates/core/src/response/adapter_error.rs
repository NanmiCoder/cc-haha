use serde_json::Value;
use thiserror::Error;

use crate::{DeliverySemantics, ErrorCode, InteractionPolicy};

#[derive(Debug, Error, Clone)]
#[error("{message}")]
pub struct AdapterError {
    pub code: ErrorCode,
    pub message: String,
    pub suggestion: Option<String>,
    pub platform_detail: Option<String>,
    pub details: Option<Value>,
    pub disposition: DeliverySemantics,
    retryability: crate::response::retryability::Retryability,
}

impl AdapterError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            suggestion: None,
            platform_detail: None,
            details: None,
            disposition: DeliverySemantics::unknown(),
            retryability: crate::response::retryability::Retryability::Unspecified,
        }
    }

    pub fn with_suggestion(mut self, suggestion: impl Into<String>) -> Self {
        self.suggestion = Some(suggestion.into());
        self
    }

    pub fn with_platform_detail(mut self, detail: impl Into<String>) -> Self {
        self.platform_detail = Some(detail.into());
        self
    }

    pub fn with_details(mut self, details: Value) -> Self {
        let retryability = crate::response::retryability::Retryability::from_details(&details);
        if retryability != crate::response::retryability::Retryability::Unspecified {
            self.retryability = retryability;
        }
        self.details = Some(details);
        self
    }

    pub fn with_disposition(mut self, disposition: DeliverySemantics) -> Self {
        self.disposition = disposition;
        self
    }

    pub fn is_explicitly_retryable(&self) -> bool {
        self.retryability == crate::response::retryability::Retryability::Retryable
    }

    /// Whether the error is an incomplete read an adapter's own loop retries
    /// inside the operation budget: an explicitly retryable `TIMEOUT` or
    /// `APP_UNRESPONSIVE`. Deadline exhaustion carries no retryable stamp, so
    /// it is not one.
    pub fn is_transient_incomplete_read(&self) -> bool {
        matches!(self.code, ErrorCode::Timeout | ErrorCode::AppUnresponsive)
            && self.is_explicitly_retryable()
    }

    pub(crate) fn is_retryable_resolution_failure(&self) -> bool {
        matches!(
            self.code,
            ErrorCode::StaleRef
                | ErrorCode::AmbiguousTarget
                | ErrorCode::Timeout
                | ErrorCode::AppUnresponsive
        ) && self.is_explicitly_retryable()
    }

    pub fn permits_retry_by_default(&self) -> bool {
        self.retryability != crate::response::retryability::Retryability::NonRetryable
    }

    /// Marks a lookup refusal raised before anything was sent to the
    /// application as `not_delivered`, keeping any stronger evidence the
    /// error already carries.
    pub(crate) fn unsent(mut self) -> Self {
        if self.disposition == DeliverySemantics::unknown() {
            self.disposition = DeliverySemantics::not_delivered();
        }
        self
    }

    pub fn stale_ref(ref_id: &str) -> Self {
        Self::new(
            ErrorCode::StaleRef,
            format!("{ref_id} not found in current RefMap"),
        )
        .with_suggestion(
            "Re-run a snapshot to obtain fresh refs, then retry with the new ref \
             (CLI: snapshot [--skeleton]; FFI: ad_snapshot then pass the printed qualified ref to ad_execute_by_ref)",
        )
        .with_disposition(DeliverySemantics::not_delivered())
    }

    /// `STALE_REF` for a resolved-but-mismatched ref, where the caller
    /// already knows the specific reason (an unavailable process instance, a
    /// missing identity) rather than the plain not-found case `stale_ref`
    /// covers.
    pub fn stale_ref_because(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::StaleRef, message)
            .with_suggestion("Run 'snapshot' to refresh, then retry with the updated ref.")
            .with_disposition(DeliverySemantics::not_delivered())
    }

    pub fn ambiguous_target(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::AmbiguousTarget, message)
            .with_suggestion(
                "Re-run a snapshot to refresh refs, then retry with a more specific ref",
            )
            .with_disposition(DeliverySemantics::not_delivered())
    }

    /// `AMBIGUOUS_TARGET` for a process resolved by name alone - `launch` and
    /// the shared app lookup behind `close-app`, `wait`, `screenshot`, and
    /// friends. None of those commands take a pid, an instance token, or a
    /// ref, so the suggestion names the candidates instead of pointing at a
    /// flag none of them have.
    pub fn ambiguous_process_target(message: impl Into<String>, pids: &[crate::ProcessId]) -> Self {
        Self::ambiguous_process_target_with_details(
            message,
            pids,
            serde_json::json!({ "candidate_pids": pids }),
        )
    }

    /// As [`Self::ambiguous_process_target`], but for a caller that already
    /// has a richer details object of its own (candidate summaries, a
    /// truncation flag) - built directly rather than through the plain
    /// constructor's own details, which `with_details` would otherwise
    /// discard wholesale in favor of this one.
    pub fn ambiguous_process_target_with_details(
        message: impl Into<String>,
        pids: &[crate::ProcessId],
        details: Value,
    ) -> Self {
        let numeric: Vec<u32> = pids.iter().map(|pid| pid.get()).collect();
        Self::new(ErrorCode::AmbiguousTarget, message)
            .with_suggestion(format!(
                "{} running instances match (pids {numeric:?}); this command selects a \
                 process by name and has no pid or instance flag to disambiguate",
                pids.len()
            ))
            .with_details(details)
            .with_disposition(DeliverySemantics::not_delivered())
    }

    pub fn not_supported(method: &str) -> Self {
        Self::new(
            ErrorCode::PlatformNotSupported,
            format!("{method} is not supported on this platform"),
        )
        .with_suggestion(
            "Use a platform/build that advertises this capability or choose a supported command",
        )
        .with_disposition(DeliverySemantics::not_delivered())
    }

    /// Whether this error is the trait-default answer a defaulted capability
    /// method returns for `method` - the marker a caller consults to fall
    /// through to an older path rather than to treat as a deliberate
    /// refusal. A platform's own "this build does not expose it" refusal
    /// carries the same code but not this message, so the two stay
    /// distinguishable.
    pub fn is_default_not_supported(&self, method: &str) -> bool {
        self.code == ErrorCode::PlatformNotSupported
            && self.message == format!("{method} is not supported on this platform")
    }

    pub fn element_not_found(ref_id: &str) -> Self {
        Self::new(
            ErrorCode::ElementNotFound,
            format!("Element {ref_id} could not be resolved"),
        )
        .with_suggestion("Re-run a snapshot to obtain fresh refs, then retry with the new ref")
        .with_disposition(DeliverySemantics::not_delivered())
    }

    pub fn timeout(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Timeout, message)
            .with_suggestion("The target application may be busy or unresponsive")
    }

    pub fn notification_not_found(index: usize) -> Self {
        Self::new(
            ErrorCode::NotificationNotFound,
            format!("Notification at index {index} not found"),
        )
        .with_suggestion(
            "Notification may have been dismissed or expired. \
             Re-run a notification list to see current notifications \
             (CLI: list-notifications; FFI: ad_list_notifications)",
        )
        .with_disposition(DeliverySemantics::not_delivered())
    }

    pub fn app_unresponsive(app: &str) -> Self {
        Self::new(
            ErrorCode::AppUnresponsive,
            format!("Application '{app}' is not responding"),
        )
        .with_suggestion("Wait for the app to recover or force-quit it before retrying automation")
        .with_disposition(DeliverySemantics::not_delivered())
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Internal, message)
    }

    pub fn permission_denied() -> Self {
        Self::new(
            ErrorCode::PermDenied,
            "Accessibility permission not granted",
        )
        .with_suggestion(
            "Run agent-desktop permissions to see which permission is denied and how to grant it. On macOS, agent-desktop permissions --guide opens System Settings with a guide",
        )
        .with_disposition(DeliverySemantics::not_delivered())
    }

    pub fn snapshot_not_found(snapshot_id: &str) -> Self {
        Self::new(
            ErrorCode::SnapshotNotFound,
            format!("Snapshot '{snapshot_id}' not found"),
        )
        .with_suggestion(
            "Re-run a snapshot and retry with a ref from the returned snapshot \
             (CLI: snapshot, then use the printed @<snapshot_id>:eN ref; FFI: ad_snapshot then pass the printed qualified ref to ad_execute_by_ref). \
             Snapshots are scoped to the session that took them, so take the snapshot under the same --session \
             or AGENT_DESKTOP_SESSION you act with: one taken outside a session is not visible to a session-scoped \
             action, and re-running it outside the session will fail the same way",
        )
        .with_disposition(DeliverySemantics::not_delivered())
    }

    pub fn policy_denied(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::PolicyDenied, message)
            .with_suggestion(
                "Use an explicit mouse/focus command if physical interaction is intended",
            )
            .with_disposition(DeliverySemantics::not_delivered())
    }

    pub fn policy_denied_for_policy(message: impl Into<String>, policy: InteractionPolicy) -> Self {
        Self::new(ErrorCode::PolicyDenied, message)
            .with_suggestion(policy_denied_suggestion(policy))
            .with_disposition(DeliverySemantics::not_delivered())
    }

    pub fn renderer_accessibility_activation_required(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::ActionNotSupported, message)
            .with_details(serde_json::json!({
                "renderer_accessibility_activation_required": true,
            }))
            .with_disposition(DeliverySemantics::not_delivered())
    }

    pub fn requires_renderer_accessibility_activation(&self) -> bool {
        self.details
            .as_ref()
            .and_then(|details| details.get("renderer_accessibility_activation_required"))
            .and_then(Value::as_bool)
            == Some(true)
    }
}

fn policy_denied_suggestion(policy: InteractionPolicy) -> &'static str {
    if policy.allow_focus_steal && !policy.allow_cursor_move {
        "Enable cursor movement in the interaction policy to permit cursor-driven actions \
         (CLI: --headed; FFI: set allow_cursor_move in the policy), \
         or use an explicit mouse command if physical input is intended"
    } else if !policy.allow_focus_steal && !policy.allow_cursor_move {
        "Headless mode allows only accessibility-backed actions; \
         enable physical interaction in the policy (CLI: --headed) only if cursor/focus movement is intended, \
         otherwise refresh the snapshot or target an element with the needed semantic action"
    } else {
        "Use an explicit mouse/focus command if physical interaction is intended"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_default_not_supported_marker_recognizes_only_its_own_constructor() {
        let default = AdapterError::not_supported("resolve_shell_surface");
        assert!(default.is_default_not_supported("resolve_shell_surface"));
        assert!(!default.is_default_not_supported("list_surfaces"));

        let refusal = AdapterError::new(
            ErrorCode::PlatformNotSupported,
            "the running build does not expose the 'quick-settings' shell surface",
        );
        assert!(
            !refusal.is_default_not_supported("resolve_shell_surface"),
            "a platform's own refusal must not read as the trait default, or core \
             would fall through to the application path instead of surfacing it"
        );
    }

    #[test]
    fn stale_ref_because_pins_code_message_suggestion_and_disposition() {
        let error =
            AdapterError::stale_ref_because("Saved target has no process instance identity");

        assert_eq!(error.code, ErrorCode::StaleRef);
        assert_eq!(
            error.message,
            "Saved target has no process instance identity"
        );
        assert_eq!(
            error.suggestion.as_deref(),
            Some("Run 'snapshot' to refresh, then retry with the updated ref.")
        );
        assert_eq!(error.disposition, DeliverySemantics::not_delivered());
        assert!(error.details.is_none());
        assert!(error.permits_retry_by_default());
    }

    #[test]
    fn retryability_is_typed_once_and_survives_diagnostic_enrichment() {
        let error = AdapterError::new(ErrorCode::StaleRef, "stale")
            .with_details(serde_json::json!({ "retryable": true }))
            .with_details(serde_json::json!({ "phase": "resolve" }));

        assert!(error.is_explicitly_retryable());
        assert!(error.permits_retry_by_default());
    }

    #[test]
    fn explicit_non_retryable_evidence_overrides_code_defaults() {
        let error = AdapterError::new(ErrorCode::StaleRef, "stale")
            .with_details(serde_json::json!({ "retryable": false }));

        assert!(!error.is_explicitly_retryable());
        assert!(!error.permits_retry_by_default());
    }

    #[test]
    fn retryable_resolution_failure_characterizes_every_error_code() {
        let all = [
            ErrorCode::PermDenied,
            ErrorCode::ElementNotFound,
            ErrorCode::AppNotFound,
            ErrorCode::ActionFailed,
            ErrorCode::ActionNotSupported,
            ErrorCode::StaleRef,
            ErrorCode::AmbiguousTarget,
            ErrorCode::WindowNotFound,
            ErrorCode::PlatformNotSupported,
            ErrorCode::Timeout,
            ErrorCode::InvalidArgs,
            ErrorCode::NotificationNotFound,
            ErrorCode::SnapshotNotFound,
            ErrorCode::PolicyDenied,
            ErrorCode::AppUnresponsive,
            ErrorCode::Internal,
        ];
        let retryable = [
            ErrorCode::StaleRef,
            ErrorCode::AmbiguousTarget,
            ErrorCode::Timeout,
            ErrorCode::AppUnresponsive,
        ];

        for code in all {
            let expected = retryable.contains(&code);
            let error = AdapterError::new(code.clone(), "failure")
                .with_details(serde_json::json!({ "retryable": true }));
            assert_eq!(error.is_retryable_resolution_failure(), expected);
            assert!(!AdapterError::new(code, "failure").is_retryable_resolution_failure());
        }
    }
}
