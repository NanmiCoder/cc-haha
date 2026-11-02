use crate::{
    ActionRequest, ActionResult, AdapterError, AppError, Deadline,
    ref_action::ref_action_context::RefActionContext,
    ref_action::ref_action_poll::execute_poll_loop,
    ref_action::ref_action_poll_state::RefActionPollState,
    ref_action::ref_action_single::execute_single_shot,
    ref_action::ref_action_wait_context::RefActionWaitContext,
    ref_action::ref_action_wait_support::enrich_with_process_state,
};

#[cfg(test)]
use crate::{context::CommandContext, refs::RefEntry};
#[cfg(test)]
type RefActionWaitCtx<'a> = RefActionWaitContext<'a>;

pub(crate) fn execute_with_auto_wait(
    context: RefActionWaitContext<'_>,
    request: ActionRequest,
    dispatch: impl Fn(
        RefActionContext<'_>,
        ActionRequest,
        &crate::InteractionLease,
    ) -> Result<ActionResult, AppError>,
) -> Result<ActionResult, AdapterError> {
    let (result, lease, pre, deadline, _lease_started) =
        execute_with_auto_wait_and_lease(context, request, dispatch)?;
    drop(lease);
    crate::ref_action::finish_artifacts(RefActionContext::new(context, deadline), &pre);
    Ok(result)
}

pub(crate) fn execute_with_auto_wait_and_lease(
    context: RefActionWaitContext<'_>,
    request: ActionRequest,
    dispatch: impl Fn(
        RefActionContext<'_>,
        ActionRequest,
        &crate::InteractionLease,
    ) -> Result<ActionResult, AppError>,
) -> Result<
    (
        ActionResult,
        crate::InteractionLease,
        crate::trace::trace_artifacts::ArtifactOutcome,
        Deadline,
        std::time::Instant,
    ),
    AdapterError,
> {
    let deadline = operation_deadline(&request)?;
    let result = execute_with_deadline(context, request, deadline, dispatch);
    result.map_err(|error| {
        if deadline.is_expired() {
            error
        } else {
            enrich_with_process_state(context.adapter, context.entry, error, deadline)
        }
    })
}

fn execute_with_deadline(
    context: RefActionWaitContext<'_>,
    mut request: ActionRequest,
    deadline: Deadline,
    dispatch: impl Fn(
        RefActionContext<'_>,
        ActionRequest,
        &crate::InteractionLease,
    ) -> Result<ActionResult, AppError>,
) -> Result<
    (
        ActionResult,
        crate::InteractionLease,
        crate::trace::trace_artifacts::ArtifactOutcome,
        Deadline,
        std::time::Instant,
    ),
    AdapterError,
> {
    let state = if request.timeout_ms.is_some_and(|timeout_ms| timeout_ms > 0) {
        execute_poll_loop(context, &request, deadline)?
    } else {
        RefActionPollState::default()
    };
    let pre = crate::ref_action::capture_pre_artifact(
        context.context,
        context.adapter,
        context.entry,
        deadline,
    );
    let cursor = crate::cursor_overlay::hold_cursor(context.context, deadline);
    crate::ref_action::presentation::before_lease(context, &request, deadline, cursor.is_ok());
    let lease = context
        .adapter
        .acquire_interaction_lease(deadline)
        .map_err(|error| state.attach_error_metrics(error))?;
    if deadline.is_expired() {
        return Err(state.attach_error_metrics(deadline.timeout_error()));
    }
    if request.timeout_ms.is_some_and(|timeout_ms| timeout_ms > 0) {
        request.timeout_ms = Some(deadline.remaining_ms());
    }
    let lease_started = std::time::Instant::now();
    let mut result = match execute_single_shot(context, request, deadline, &lease, dispatch) {
        Ok(result) => result,
        Err(error) => {
            drop(lease);
            crate::ref_action::finish_artifacts(RefActionContext::new(context, deadline), &pre);
            return Err(error);
        }
    };
    state.attach_transient_ambiguity(&mut result);
    state.attach_wait_metrics(
        &mut result,
        &lease,
        u64::try_from(lease_started.elapsed().as_millis()).unwrap_or(u64::MAX),
    );
    Ok((result, lease, pre, deadline, lease_started))
}

pub(crate) fn operation_deadline(request: &ActionRequest) -> Result<Deadline, AdapterError> {
    request
        .timeout_ms
        .filter(|timeout_ms| *timeout_ms > 0)
        .map_or_else(Deadline::standard, Deadline::after)
}

#[cfg(test)]
#[path = "ref_action_wait_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "ref_action_wait_process_state_tests.rs"]
mod process_state_tests;

#[cfg(test)]
#[path = "ref_action_wait_app_not_found_tests.rs"]
mod app_not_found_tests;

#[cfg(test)]
#[path = "ref_action_wait_success_tests.rs"]
mod success_tests;

#[cfg(test)]
#[path = "ref_action_exactly_once_tests.rs"]
mod exactly_once_tests;

#[cfg(test)]
#[path = "ref_action_focus_order_tests.rs"]
mod focus_order_tests;
