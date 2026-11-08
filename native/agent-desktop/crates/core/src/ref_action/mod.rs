use crate::actions::action_request::ActionRequest;
use crate::actions::action_result::ActionResult;
use crate::adapter::{NativeHandle, PlatformAdapter};
use crate::context::CommandContext;
use crate::ref_action::ref_action_context::RefActionContext;
use crate::ref_action::ref_action_wait_support::{after_scroll, trace_scroll_error};
use crate::refs::RefEntry;
use crate::{AdapterError, AppError, actionability};
use serde_json::json;

pub(crate) mod presentation;
pub(crate) mod ref_action_actionability;
pub(crate) mod ref_action_context;
pub(crate) mod ref_action_poll;
pub(crate) mod ref_action_poll_state;
pub(crate) mod ref_action_single;
pub(crate) mod ref_action_wait;
pub(crate) mod ref_action_wait_context;
pub(crate) mod ref_action_wait_evidence;
pub(crate) mod ref_action_wait_support;

const TRACE_CAPTURE_BUDGET_MS: u64 = 1_000;
const PRE_CAPTURE_DISPATCH_RESERVE_MS: u64 = 100;

/// A strictly resolved ref-action target plus the tracing identity for it.
pub(crate) struct ResolvedRefAction<'a> {
    target: RefActionContext<'a>,
    pub(crate) handle: &'a NativeHandle,
}

pub(crate) struct ActionabilityPreflight {
    pub(crate) verified_point: Option<crate::Point>,
    pub(crate) presentation_point: Option<crate::Point>,
    pub(crate) presentation_bounds: Option<crate::Rect>,
    pub(crate) pointer_delivery: actionability::PointerDelivery,
}

impl<'a> ResolvedRefAction<'a> {
    pub(crate) fn new(target: RefActionContext<'a>, handle: &'a NativeHandle) -> Self {
        Self { target, handle }
    }
}

impl<'a> std::ops::Deref for ResolvedRefAction<'a> {
    type Target = RefActionContext<'a>;

    fn deref(&self) -> &Self::Target {
        &self.target
    }
}

pub(crate) fn preflight_resolved(
    target: &ResolvedRefAction<'_>,
    request: &ActionRequest,
    stability: actionability::StabilityExpectation,
) -> Result<ActionabilityPreflight, AppError> {
    check_actionability_with_trace(target, request, stability)
}

pub(crate) fn dispatch_resolved(
    target: RefActionContext<'_>,
    mut request: ActionRequest,
    lease: &crate::InteractionLease,
) -> Result<ActionResult, AppError> {
    let process_instance = target
        .entry
        .process
        .process_instance
        .as_deref()
        .filter(|instance| !instance.is_empty())
        .ok_or_else(|| AdapterError::stale_ref_because("target process instance is unavailable"))?;
    let expected_process = crate::ProcessIdentity::new(target.entry.process.pid, process_instance);
    let mut handle = target
        .adapter
        .resolve_element_strict(target.entry, target.deadline)
        .map_err(mark_pre_dispatch_resolution_failure)
        .inspect_err(|error| {
            crate::ref_action::ref_action_wait_support::trace_resolve_error(
                target.context,
                target.ref_id,
                error,
            )
        })?;
    crate::ref_action::ref_action_wait_support::trace_resolve_ok(target.context, target.ref_id);
    let initial_target = ResolvedRefAction::new(target, &handle);
    let preflight = match stable_preflight(&initial_target, &request) {
        Ok(preflight) => preflight,
        Err(error) => {
            let error = into_adapter_error(error);
            if !crate::ref_action::ref_action_wait_evidence::should_scroll_after_preflight(
                &request, &error,
            ) {
                return Err(error.into());
            }
            let recovered = match target
                .adapter
                .scroll_ref_into_view(target.entry, &handle, lease)
            {
                Ok(recovered) => recovered,
                Err(scroll_error) => {
                    trace_scroll_error(&target, &scroll_error);
                    return Err(
                        crate::ref_action::ref_action_wait_evidence::attach_scroll_recovery_failure(
                            error,
                            &scroll_error,
                        )
                        .into(),
                    );
                }
            };
            handle = match recovered {
                Some(handle) => handle,
                None => target
                    .adapter
                    .resolve_element_strict(target.entry, target.deadline)
                    .map_err(after_scroll)?,
            };
            let scrolled_target = ResolvedRefAction::new(target, &handle);
            stable_preflight(&scrolled_target, &request)
                .map_err(|error| after_scroll(into_adapter_error(error)))?
        }
    };
    if matches!(
        preflight.pointer_delivery,
        actionability::PointerDelivery::Semantic
    ) {
        request.policy = crate::InteractionPolicy::headless();
    }
    request = request
        .with_verified_point(preflight.verified_point.clone())
        .with_expected_process(expected_process.clone());
    let final_target = ResolvedRefAction::new(target, &handle);
    final_target.context.trace_lazy(
        "action.dispatch.start",
        || json!({ "ref": final_target.ref_id, "action": request.action.name() }),
    )?;
    let action_name = request.action.name();
    let raises_surface = request.action.may_raise_surface();
    let presentation_action = request.action.clone();
    let ripples = presentation::effect_ripples(&final_target, &presentation_action);
    presentation::before_dispatch(&final_target, &preflight, &presentation_action, lease);
    let dispatch_result =
        crate::execute_verified_action(final_target.adapter, final_target.handle, request, lease);
    let mut preflight = preflight;
    if presentation::after_text_entry(&final_target, &presentation_action, &dispatch_result) {
        preflight.presentation_bounds = None;
    }
    presentation::after_dispatch(
        final_target.adapter,
        final_target.context,
        &preflight,
        ripples,
        &dispatch_result,
    );
    let mut result = dispatch_result?;
    if raises_surface {
        result.surfaces = settled_surfaces(&final_target, expected_process);
    }
    final_target
        .context
        .trace_lazy(
            "action.dispatch.ok",
            || json!({ "ref": final_target.ref_id, "action": action_name, "result": &result }),
        )
        .map_err(trace_error_after_delivery)?;
    Ok(result)
}

/// An action that opens a sheet, menu, or alert leaves the caller staring at a
/// success envelope with no hint that the application is now waiting on a
/// dialog. Reporting the overlays saves a round of window archaeology. Purely
/// informational, so a failed read never disturbs delivered work.
fn settled_surfaces(
    target: &ResolvedRefAction<'_>,
    process: crate::ProcessIdentity,
) -> Vec<crate::SurfaceInfo> {
    target
        .adapter
        .list_surfaces(process, target.deadline)
        .unwrap_or_default()
}

pub(crate) fn mark_pre_dispatch_resolution_failure(error: AdapterError) -> AdapterError {
    match error.disposition {
        crate::DeliverySemantics::Unknown | crate::DeliverySemantics::NotDelivered => {
            error.with_disposition(crate::DeliverySemantics::not_delivered())
        }
        crate::DeliverySemantics::DeliveryUncertain
        | crate::DeliverySemantics::DeliveredUnverified
        | crate::DeliverySemantics::DeliveredVerified => error,
    }
}

pub(crate) fn capture_pre_artifact(
    context: &CommandContext,
    adapter: &dyn PlatformAdapter,
    entry: &RefEntry,
    deadline: crate::Deadline,
) -> crate::trace::trace_artifacts::ArtifactOutcome {
    let Some(capture_deadline) = pre_trace_capture_deadline(deadline) else {
        return crate::trace::trace_artifacts::ArtifactOutcome::Skipped("dispatch_budget".into());
    };
    crate::trace::trace_artifacts::capture_action_screenshot(
        context,
        adapter,
        entry,
        "pre",
        capture_deadline,
    )
}

pub(crate) fn finish_artifacts(
    target: RefActionContext<'_>,
    pre: &crate::trace::trace_artifacts::ArtifactOutcome,
) {
    let post = crate::trace::trace_artifacts::capture_action_screenshot(
        target.context,
        target.adapter,
        target.entry,
        "post",
        trace_capture_deadline(target.deadline),
    );
    if let Err(error) = crate::trace::trace_artifacts::emit_action_artifacts(
        target.context,
        target.ref_id,
        pre,
        &post,
    ) {
        tracing::warn!(error = %error, ref_id = target.ref_id, "action artifact emission failed");
    }
}

fn trace_error_after_delivery(error: AppError) -> AppError {
    crate::context::trace_error_with_disposition(
        error,
        crate::DeliverySemantics::delivered_unverified(),
    )
}

fn trace_capture_deadline(parent: crate::Deadline) -> crate::Deadline {
    parent.capped(std::time::Duration::from_millis(TRACE_CAPTURE_BUDGET_MS))
}

fn pre_trace_capture_deadline(parent: crate::Deadline) -> Option<crate::Deadline> {
    let remaining = parent.remaining();
    let reserve = std::time::Duration::from_millis(PRE_CAPTURE_DISPATCH_RESERVE_MS);
    if remaining <= reserve {
        return None;
    }
    let capture_budget = remaining
        .saturating_sub(reserve)
        .min(std::time::Duration::from_millis(TRACE_CAPTURE_BUDGET_MS));
    Some(parent.capped(capture_budget))
}

/// The permissive check compares live bounds against the ref's
/// snapshot-time evidence, which a caller's own preceding `scroll-to` on
/// this same ref legitimately moved - so a report whose only gap is
/// `stable` is not yet a verdict, it is the reason to sample. Anything else
/// unmet (disabled, hidden, policy) is terminal immediately: no amount of
/// waiting changes it, and `check_live_with_stability_or_gap` already
/// converts those to `Err` for us.
fn stable_preflight(
    target: &ResolvedRefAction<'_>,
    request: &ActionRequest,
) -> Result<ActionabilityPreflight, AppError> {
    let stability =
        actionability::StabilityExpectation::permissive(target.entry.geometry.bounds_hash);
    let report = ref_action_actionability::check_report_with_trace(
        target,
        request,
        stability,
        actionability::check_live_with_stability_or_gap,
    )?;
    if report.actionable {
        return Ok(ref_action_actionability::preflight_from_report(&report));
    }
    let started = crate::wait::deadline::now();
    let mut sampler = actionability::stability_sampler::StabilitySampler::new();
    loop {
        let bounds = target
            .adapter
            .get_element_bounds(target.handle, target.deadline)?;
        let elapsed = crate::wait::deadline::now().saturating_duration_since(started);
        if sampler.observe(bounds, elapsed) {
            let stability = actionability::StabilityExpectation::strict(
                sampler.bounds(),
                sampler.samples(),
                u64::try_from(sampler.stable_span(elapsed).as_millis()).unwrap_or(u64::MAX),
            );
            return check_actionability_with_trace(target, request, stability);
        }
        let sleep = target
            .deadline
            .remaining_slice(actionability::stability_sampler::STABILITY_SAMPLE_INTERVAL)
            .map_err(|error| error.with_disposition(crate::DeliverySemantics::not_delivered()))?;
        crate::wait::deadline::sleep(sleep);
    }
}

#[cfg(test)]
pub(crate) fn execute_resolved(
    target: ResolvedRefAction<'_>,
    request: ActionRequest,
    lease: &crate::InteractionLease,
) -> Result<ActionResult, AppError> {
    let pre = capture_pre_artifact(
        target.context,
        target.adapter,
        target.entry,
        target.deadline,
    );
    let stability =
        actionability::StabilityExpectation::permissive(target.entry.geometry.bounds_hash);
    preflight_resolved(&target, &request, stability)?;
    let result = dispatch_resolved(target.target, request, lease);
    finish_artifacts(target.target, &pre);
    result
}

fn check_actionability_with_trace(
    target: &ResolvedRefAction<'_>,
    request: &ActionRequest,
    stability: actionability::StabilityExpectation,
) -> Result<ActionabilityPreflight, AppError> {
    let report = ref_action_actionability::check_report_with_trace(
        target,
        request,
        stability,
        actionability::check_live_with_stability,
    )?;
    Ok(ref_action_actionability::preflight_from_report(&report))
}

/// Builds a stable, non-sensitive trace label from a `RefEntry`. The label
/// is derived from role and path indices only — no content fields — so it is
/// safe to emit in the `"ref"` trace key without redaction risk. Path indices
/// are deterministic within a snapshot but carry no secret information.
fn ref_label_from_entry(entry: &RefEntry) -> String {
    if entry.scope.path.is_empty() {
        return format!("<{}>", entry.identity.role);
    }
    let indices: Vec<String> = entry.scope.path.iter().map(|i| i.to_string()).collect();
    format!("<{}/{}>", entry.identity.role, indices.join("/"))
}

/// Executes a pre-resolved ref-action entry using the provided `context` for
/// session identity and trace emission. Prefer this over `execute_entry` when
/// a real `CommandContext` is available (e.g. from `AdAdapter::command_context`
/// in the FFI layer), so that trace events carry the correct session id.
///
/// Trace records use a role/path-derived label for the `"ref"` field so that
/// FFI call-site events are distinguishable in multi-element trace logs. The
/// label never includes content fields (name, value, text) that are subject to
/// redaction.
pub fn execute_entry_with_context(
    adapter: &dyn PlatformAdapter,
    entry: &RefEntry,
    request: ActionRequest,
    context: &CommandContext,
) -> Result<ActionResult, AdapterError> {
    let label = ref_label_from_entry(entry);
    crate::ref_action::ref_action_wait::execute_with_auto_wait(
        crate::ref_action::ref_action_wait_context::RefActionWaitContext {
            adapter,
            entry,
            ref_id: &label,
            context,
        },
        request,
        dispatch_resolved,
    )
}

/// Executes a pre-resolved ref-action entry with a default (no-session,
/// no-trace) `CommandContext`. Existing callers outside the FFI layer that do
/// not have a live session context continue to use this entry point unchanged.
pub fn execute_entry(
    adapter: &dyn PlatformAdapter,
    entry: &RefEntry,
    request: ActionRequest,
) -> Result<ActionResult, AdapterError> {
    execute_entry_with_context(adapter, entry, request, &CommandContext::default())
}

pub(crate) fn into_adapter_error(err: AppError) -> AdapterError {
    match err {
        AppError::Adapter(err) => err,
        other => AdapterError::internal(other.to_string()),
    }
}

#[cfg(test)]
#[path = "ref_action_tests.rs"]
mod tests;
