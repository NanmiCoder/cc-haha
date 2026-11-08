use crate::{
    AppError,
    actions::action::Action,
    adapter::PlatformAdapter,
    commands::helpers::{RefArgs, execute_ref_action_with_context},
    context::CommandContext,
};
use serde_json::Value;

pub fn execute(
    args: RefArgs,
    adapter: &dyn PlatformAdapter,
    context: &CommandContext,
) -> Result<Value, AppError> {
    execute_ref_action_with_context(
        args,
        adapter,
        context.request_base(Action::Uncheck),
        context,
    )
}
