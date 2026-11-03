use crate::{
    AppError,
    actions::action::Action,
    adapter::PlatformAdapter,
    commands::helpers::{RefArgs, execute_ref_action_with_context},
    context::CommandContext,
};
use serde_json::Value;

pub struct SetValueArgs {
    pub ref_id: String,
    pub value: String,
    pub timeout_ms: Option<u64>,
}

pub fn execute(
    args: SetValueArgs,
    adapter: &dyn PlatformAdapter,
    context: &CommandContext,
) -> Result<Value, AppError> {
    let request = context.request_base(Action::SetValue(args.value));
    execute_ref_action_with_context(
        RefArgs {
            ref_id: args.ref_id,
            timeout_ms: args.timeout_ms,
        },
        adapter,
        request,
        context,
    )
}

#[cfg(test)]
#[path = "set_value_tests.rs"]
mod tests;
