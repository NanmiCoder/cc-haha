use agent_desktop_core::{
    AppError, PlatformAdapter,
    commands::{
        check as check_command, clear as clear_command, click as click_command,
        collapse as collapse_command, double_click as double_click_command,
        expand as expand_command, focus as focus_command, helpers,
        right_click as right_click_command, scroll as scroll_command,
        scroll_to as scroll_to_command, select as select_command, set_value as set_value_command,
        toggle as toggle_command, triple_click as triple_click_command,
        type_text as type_text_command, uncheck as uncheck_command,
    },
    context::CommandContext,
};
use serde_json::Value;

use crate::cli_args::{
    RefArgs,
    actions::{ScrollArgs, SelectArgs, SetValueArgs, TypeArgs},
};
use crate::dispatch::parse::parse_direction;

pub(super) fn click(
    args: RefArgs,
    adapter: &dyn PlatformAdapter,
    context: &CommandContext,
) -> Result<Value, AppError> {
    click_command::execute(ref_args(args), adapter, context)
}

pub(super) fn double_click(
    args: RefArgs,
    adapter: &dyn PlatformAdapter,
    context: &CommandContext,
) -> Result<Value, AppError> {
    double_click_command::execute(ref_args(args), adapter, context)
}

pub(super) fn triple_click(
    args: RefArgs,
    adapter: &dyn PlatformAdapter,
    context: &CommandContext,
) -> Result<Value, AppError> {
    triple_click_command::execute(ref_args(args), adapter, context)
}

pub(super) fn right_click(
    args: RefArgs,
    adapter: &dyn PlatformAdapter,
    context: &CommandContext,
) -> Result<Value, AppError> {
    right_click_command::execute(ref_args(args), adapter, context)
}

pub(super) fn type_text(
    args: TypeArgs,
    adapter: &dyn PlatformAdapter,
    context: &CommandContext,
) -> Result<Value, AppError> {
    let timeout_ms = match args.interval_ms {
        Some(_) => args.timeout_ms,
        None => helpers::normalize_action_timeout_ms(args.effective_timeout_ms()),
    };
    type_text_command::execute(
        type_text_command::TypeArgs {
            ref_id: args.ref_id,
            text: args.text,
            timeout_ms,
            interval_ms: args.interval_ms,
        },
        adapter,
        context,
    )
}

pub(super) fn set_value(
    args: SetValueArgs,
    adapter: &dyn PlatformAdapter,
    context: &CommandContext,
) -> Result<Value, AppError> {
    set_value_command::execute(
        set_value_command::SetValueArgs {
            ref_id: args.ref_id,
            value: args.value,
            timeout_ms: helpers::normalize_action_timeout_ms(args.timeout_ms),
        },
        adapter,
        context,
    )
}

pub(super) fn clear(
    args: RefArgs,
    adapter: &dyn PlatformAdapter,
    context: &CommandContext,
) -> Result<Value, AppError> {
    clear_command::execute(ref_args(args), adapter, context)
}

pub(super) fn focus(
    args: RefArgs,
    adapter: &dyn PlatformAdapter,
    context: &CommandContext,
) -> Result<Value, AppError> {
    focus_command::execute(ref_args(args), adapter, context)
}

pub(super) fn toggle(
    args: RefArgs,
    adapter: &dyn PlatformAdapter,
    context: &CommandContext,
) -> Result<Value, AppError> {
    toggle_command::execute(ref_args(args), adapter, context)
}

pub(super) fn check(
    args: RefArgs,
    adapter: &dyn PlatformAdapter,
    context: &CommandContext,
) -> Result<Value, AppError> {
    check_command::execute(ref_args(args), adapter, context)
}

pub(super) fn uncheck(
    args: RefArgs,
    adapter: &dyn PlatformAdapter,
    context: &CommandContext,
) -> Result<Value, AppError> {
    uncheck_command::execute(ref_args(args), adapter, context)
}

pub(super) fn expand(
    args: RefArgs,
    adapter: &dyn PlatformAdapter,
    context: &CommandContext,
) -> Result<Value, AppError> {
    expand_command::execute(ref_args(args), adapter, context)
}

pub(super) fn collapse(
    args: RefArgs,
    adapter: &dyn PlatformAdapter,
    context: &CommandContext,
) -> Result<Value, AppError> {
    collapse_command::execute(ref_args(args), adapter, context)
}

pub(super) fn select(
    args: SelectArgs,
    adapter: &dyn PlatformAdapter,
    context: &CommandContext,
) -> Result<Value, AppError> {
    select_command::execute(
        select_command::SelectArgs {
            ref_id: args.ref_id,
            value: args.value,
            timeout_ms: helpers::normalize_action_timeout_ms(args.timeout_ms),
        },
        adapter,
        context,
    )
}

pub(super) fn scroll(
    args: ScrollArgs,
    adapter: &dyn PlatformAdapter,
    context: &CommandContext,
) -> Result<Value, AppError> {
    scroll_command::execute(
        scroll_command::ScrollArgs {
            ref_id: args.ref_id,
            direction: parse_direction(&args.direction)?,
            amount: args.amount,
            timeout_ms: helpers::normalize_action_timeout_ms(args.timeout_ms),
        },
        adapter,
        context,
    )
}

pub(super) fn scroll_to(
    args: RefArgs,
    adapter: &dyn PlatformAdapter,
    context: &CommandContext,
) -> Result<Value, AppError> {
    scroll_to_command::execute(ref_args(args), adapter, context)
}

fn ref_args(args: RefArgs) -> helpers::RefArgs {
    helpers::RefArgs {
        ref_id: args.ref_id,
        timeout_ms: helpers::normalize_action_timeout_ms(args.timeout_ms),
    }
}
