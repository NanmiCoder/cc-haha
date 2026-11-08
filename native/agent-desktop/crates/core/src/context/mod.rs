use crate::{
    AdapterError, AppError, CursorOverlayConfig, SignalBaseline, actions::action::Action,
    actions::action_request::ActionRequest, actions::interaction_policy::InteractionPolicy,
    session, trace::TraceConfig,
};
use serde_json::{Value, json};
use std::cell::Cell;
use std::path::PathBuf;
use std::time::Instant;

mod cursor;
mod options;
mod session_scope;
mod wait_selector;

use options::CommandOptions;
use session_scope::SessionScope;
pub use wait_selector::WaitSelector;

#[derive(Debug, Clone, Default)]
pub struct CommandContext {
    session: Option<SessionScope>,
    pinned_session_namespace: bool,
    inherited_deadline: Option<crate::Deadline>,
    trace: TraceConfig,
    artifacts_full: bool,
    options: CommandOptions,
}

/// Emits `command.start` on construction and `command.end` on `complete`.
/// The `Drop` guard emits a fallback `command.end` for a scope abandoned
/// without `complete` (normal early return, or a panic under the unwind
/// test profile). It cannot fire on a genuine panic in the release binary:
/// `[profile.release]` uses `panic = "abort"`, which terminates without
/// unwinding `Drop`. A panicked release command therefore leaves an
/// unpaired `command.start`, which the trace reader tolerates as an
/// `unpaired_command` warning rather than a lost record.
pub struct CommandScope<'a> {
    context: &'a CommandContext,
    command: &'static str,
    success_disposition: crate::DeliverySemantics,
    started: Instant,
    finished: Cell<bool>,
    _deadline_scope: crate::wait::deadline::DeadlineScope,
}

impl CommandScope<'_> {
    pub fn complete(self, result: &Result<Value, AppError>) -> Result<(), AppError> {
        self.finished.set(true);
        let emitted = match result {
            Ok(_) => self.emit_end(true, None),
            Err(err) => self.emit_end(false, Some(err.code())),
        };
        emitted.map_err(|error| {
            trace_error_with_disposition(
                error,
                result_disposition(result, self.success_disposition),
            )
        })
    }

    fn emit_end(&self, ok: bool, code: Option<&str>) -> Result<(), AppError> {
        let mut fields = json!({
            "command": self.command,
            "ok": ok,
            "duration_ms": self.started.elapsed().as_millis(),
        });
        if let Some(code) = code {
            fields["code"] = json!(code);
        }
        self.context.trace("command.end", fields)
    }
}

impl Drop for CommandScope<'_> {
    fn drop(&mut self) {
        if self.finished.get() {
            return;
        }
        let _ = self.emit_end(false, Some("INTERNAL"));
    }
}

impl CommandContext {
    pub fn new(
        session_id: Option<String>,
        trace_path: Option<PathBuf>,
        trace_strict: bool,
    ) -> Result<Self, AppError> {
        if let Some(id) = session_id.as_deref() {
            validate_session_id(id)?;
        }
        let (segment_dir, artifacts_full) =
            session_trace_state(session_id.as_deref(), trace_path.is_some())?;
        let session = acquire_session_scope(session_id, None)?;
        let cursor_overlay =
            session::cursor_overlay_for_session(session.as_ref().map(|scope| scope.id.as_str()))?;
        Ok(Self {
            session,
            pinned_session_namespace: false,
            inherited_deadline: None,
            trace: TraceConfig::build(trace_path, segment_dir, trace_strict)?,
            artifacts_full,
            options: CommandOptions {
                cursor_overlay,
                agent_id: None,
                ..CommandOptions::default()
            },
        })
    }

    pub fn with_headed(mut self, headed: bool) -> Self {
        self.options.interaction_policy = if headed {
            InteractionPolicy::headed()
        } else {
            InteractionPolicy::headless()
        };
        self
    }

    pub fn with_interaction_policy(mut self, policy: InteractionPolicy) -> Self {
        self.options.interaction_policy = policy;
        self
    }

    pub fn with_wait_selector(mut self, wait_selector: Option<WaitSelector>) -> Self {
        self.options.wait_selector = wait_selector;
        self
    }

    pub fn wait_selector(&self) -> Option<&WaitSelector> {
        self.options.wait_selector.as_ref()
    }

    pub fn with_event_baseline(
        mut self,
        baseline: Option<Result<SignalBaseline, AdapterError>>,
    ) -> Self {
        self.options.event_baseline = baseline;
        self
    }

    pub fn cursor_overlay(&self) -> &CursorOverlayConfig {
        &self.options.cursor_overlay
    }

    #[cfg(test)]
    pub(crate) fn with_cursor_overlay_session(
        mut self,
        session_id: &str,
        cursor_overlay: CursorOverlayConfig,
    ) -> Self {
        self.session = Some(SessionScope {
            id: session_id.into(),
            lease: None,
        });
        self.options.cursor_overlay = cursor_overlay;
        self
    }

    pub fn with_pinned_session_namespace(mut self) -> Self {
        self.pinned_session_namespace = true;
        self
    }

    pub fn session_namespace_is_pinned(&self) -> bool {
        self.pinned_session_namespace
    }

    pub fn is_headed(&self) -> bool {
        self.options.interaction_policy.is_headed()
    }

    pub fn with_inherited_deadline(mut self, deadline: crate::Deadline) -> Self {
        self.inherited_deadline = Some(deadline);
        self
    }

    pub fn event_baseline(&self) -> Option<&Result<SignalBaseline, AdapterError>> {
        self.options.event_baseline.as_ref()
    }

    pub fn command_scope(&self, command: &'static str) -> Result<CommandScope<'_>, AppError> {
        self.command_scope_with_disposition(
            command,
            crate::DeliverySemantics::not_delivered(),
            false,
        )
    }

    pub fn mutating_command_scope(
        &self,
        command: &'static str,
    ) -> Result<CommandScope<'_>, AppError> {
        self.command_scope_with_disposition(
            command,
            crate::DeliverySemantics::delivered_unverified(),
            false,
        )
    }

    fn command_scope_with_disposition(
        &self,
        command: &'static str,
        success_disposition: crate::DeliverySemantics,
        allow_ended_session: bool,
    ) -> Result<CommandScope<'_>, AppError> {
        if !allow_ended_session && let Some(session) = &self.session {
            session.ensure_active()?;
        }
        let deadline_scope = crate::wait::deadline::enter_scope(self.inherited_deadline);
        self.trace("command.start", json!({ "command": command }))
            .map_err(|error| {
                trace_error_with_disposition(error, crate::DeliverySemantics::not_delivered())
            })?;
        Ok(CommandScope {
            context: self,
            command,
            success_disposition,
            started: Instant::now(),
            finished: Cell::new(false),
            _deadline_scope: deadline_scope,
        })
    }

    pub fn request(&self, action: Action, base: InteractionPolicy) -> ActionRequest {
        ActionRequest {
            action,
            policy: self.policy_with_base(base),
            timeout_ms: None,
            verified_point: None,
            expected_process: None,
        }
    }

    pub fn request_base(&self, action: Action) -> ActionRequest {
        let base = action.base_interaction_policy();
        self.request(action, base)
    }

    pub fn physical_input_policy(&self) -> InteractionPolicy {
        self.policy_with_base(InteractionPolicy::headless())
    }

    fn policy_with_base(&self, base: InteractionPolicy) -> InteractionPolicy {
        base.join(self.options.interaction_policy)
    }

    pub fn for_batch_item(&self, session_id: Option<String>) -> Result<Self, AppError> {
        let session_id = session_id.or_else(|| self.session_id().map(str::to_owned));
        if self.pinned_session_namespace && session_id.as_deref() != self.session_id() {
            return Err(AppError::invalid_input(
                "A command host cannot switch snapshot namespaces",
            ));
        }
        if let Some(id) = session_id.as_deref() {
            validate_session_id(id)?;
        }
        let reuses_parent_session = session_id.as_deref() == self.session_id();
        let reuses_parent_trace = reuses_parent_session
            || (self.trace.pending_file_path().is_some() && self.trace.has_sink());
        let (trace, artifacts_full) = if reuses_parent_trace {
            (self.trace.clone(), self.artifacts_full)
        } else {
            let (segment_dir, artifacts_full) = session_trace_state(session_id.as_deref(), false)?;
            (
                self.trace.clone_with_session_segment(segment_dir)?,
                artifacts_full,
            )
        };
        let session = if reuses_parent_session {
            self.session.clone()
        } else {
            acquire_session_scope(session_id, self.inherited_deadline)?
        };
        let cursor_overlay = if reuses_parent_session {
            self.options.cursor_overlay.clone()
        } else {
            session::cursor_overlay_for_session_agent(
                session.as_ref().map(|scope| scope.id.as_str()),
                self.agent_id(),
            )?
        };
        Ok(Self {
            session,
            pinned_session_namespace: self.pinned_session_namespace,
            inherited_deadline: self.inherited_deadline,
            trace,
            artifacts_full,
            options: self.options.for_batch(cursor_overlay),
        })
    }

    pub fn trace(&self, event: &str, fields: Value) -> Result<(), AppError> {
        self.trace.emit(event, self.session_id(), fields)
    }

    pub fn trace_lazy(&self, event: &str, fields: impl FnOnce() -> Value) -> Result<(), AppError> {
        self.trace.emit_lazy(event, self.session_id(), fields)
    }

    pub fn session_id(&self) -> Option<&str> {
        self.session.as_ref().map(|session| session.id.as_str())
    }

    pub fn trace_enabled(&self) -> bool {
        self.trace.has_sink()
    }

    pub fn artifacts_full(&self) -> bool {
        self.artifacts_full
    }
}

fn acquire_session_scope(
    session_id: Option<String>,
    deadline: Option<crate::Deadline>,
) -> Result<Option<SessionScope>, AppError> {
    let Some(session_id) = session_id else {
        return Ok(None);
    };
    let lease = match deadline {
        Some(deadline) => session::acquire_liveness_lease_with_deadline(&session_id, deadline),
        None => session::acquire_liveness_lease(&session_id),
    }?;
    Ok(Some(SessionScope {
        id: session_id,
        lease,
    }))
}

fn result_disposition(
    result: &Result<Value, AppError>,
    success_fallback: crate::DeliverySemantics,
) -> crate::DeliverySemantics {
    match result {
        Ok(value) => value
            .get("disposition")
            .cloned()
            .and_then(|value| serde_json::from_value(value).ok())
            .unwrap_or(success_fallback),
        Err(AppError::Adapter(error)) => error.disposition,
        Err(_) => crate::DeliverySemantics::unknown(),
    }
}

pub(crate) fn trace_error_with_disposition(
    error: AppError,
    disposition: crate::DeliverySemantics,
) -> AppError {
    let adapter_error = match error {
        AppError::Adapter(error) => error,
        other => crate::AdapterError::internal(other.to_string()),
    };
    AppError::Adapter(adapter_error.with_disposition(disposition))
}

fn session_trace_state(
    session_id: Option<&str>,
    explicit_trace: bool,
) -> Result<(Option<PathBuf>, bool), AppError> {
    if explicit_trace {
        return Ok((None, false));
    }
    let Some(session_id) = session_id else {
        return Ok((None, false));
    };
    let manifest = session::read_manifest(session_id)?;
    let trace_dir = if manifest.as_ref().is_some_and(|m| m.trace_enabled()) {
        Some(session::trace_dir(session_id)?)
    } else {
        None
    };
    let artifacts_full = manifest.as_ref().is_some_and(|m| m.artifacts_full());
    Ok((trace_dir, artifacts_full))
}

pub fn validate_session_id(id: &str) -> Result<(), AppError> {
    let valid = !id.is_empty()
        && id.len() <= 64
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'));
    if valid {
        return Ok(());
    }
    Err(AppError::invalid_input_with_suggestion(
        "Session id must be 1-64 chars using letters, numbers, '-' or '_'",
        "Use a short filesystem-safe session id such as run_1 or agent-a.",
    ))
}

#[cfg(test)]
#[path = "context_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "context_scope_tests.rs"]
mod scope_tests;
