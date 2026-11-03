use crate::{
    AppError,
    actions::action::Action,
    actions::action_request::ActionRequest,
    actions::interaction_policy::InteractionPolicy,
    adapter::PlatformAdapter,
    commands::helpers::{RefArgs, execute_ref_action_with_context, normalize_action_timeout_ms},
    context::CommandContext,
};
use serde_json::Value;

/// Config struct bundling the caller-supplied inputs to `execute_with_timeout`,
/// keeping it within the 5-parameter limit (mirrors the `RefArgs`/
/// `ActionRequest` config-struct pattern used elsewhere in this module).
pub struct ExecuteByRefArgs<'a> {
    pub ref_id: &'a str,
    pub action: Action,
    pub caller_policy: InteractionPolicy,
}

/// Executes an action addressed by a snapshot ref through the canonical
/// ref-action pipeline: `RefStore` load → `RefMap` lookup → strict element
/// resolution → live actionability preflight → dispatch.
///
/// `ref_id` must be snapshot-qualified (`@<snapshot_id>:eN`); a bare `@eN`
/// is rejected with `INVALID_ARGS`.
///
/// The effective `InteractionPolicy` is the join of `caller_policy` and the
/// action's base policy. Semantic actions, including `TypeText`, are strict
/// headless; explicit `PressKey` permits focus without cursor movement. FFI
/// callers may opt in to `focus_fallback` or `headed`.
pub fn execute_with_timeout(
    args: ExecuteByRefArgs<'_>,
    timeout_ms: u64,
    adapter: &dyn PlatformAdapter,
    context: &CommandContext,
) -> Result<Value, AppError> {
    let ExecuteByRefArgs {
        ref_id,
        action,
        caller_policy,
    } = args;
    let timeout_ms = normalize_action_timeout_ms(timeout_ms);
    let base = action.base_interaction_policy();
    let effective = base.join(caller_policy);
    let request = ActionRequest {
        action,
        policy: effective,
        timeout_ms,
        verified_point: None,
        expected_process: None,
    };
    execute_ref_action_with_context(
        RefArgs {
            ref_id: ref_id.to_owned(),
            timeout_ms,
        },
        adapter,
        request,
        context,
    )
}

#[cfg(test)]
#[path = "execute_by_ref_tests.rs"]
mod tests;
