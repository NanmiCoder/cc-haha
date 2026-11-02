use crate::{
    Action, AppError, Direction,
    adapter::PlatformAdapter,
    commands::helpers::{RefArgs, execute_ref_action_with_context},
    context::CommandContext,
};
use serde_json::Value;

pub struct ScrollArgs {
    pub ref_id: String,
    pub direction: Direction,
    pub amount: u32,
    pub timeout_ms: Option<u64>,
}

pub fn execute(
    args: ScrollArgs,
    adapter: &dyn PlatformAdapter,
    context: &CommandContext,
) -> Result<Value, AppError> {
    let request = context.request_base(Action::Scroll(args.direction, args.amount));
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
#[path = "scroll_tests.rs"]
mod tests;
