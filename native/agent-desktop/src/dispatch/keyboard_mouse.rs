use agent_desktop_core::{
    AppError, PlatformAdapter,
    commands::{
        drag as drag_command, helpers, hover as hover_command, key_down as key_down_command,
        key_up as key_up_command, mouse_click as mouse_click_command,
        mouse_down as mouse_down_command, mouse_move as mouse_move_command,
        mouse_up as mouse_up_command, mouse_wheel as mouse_wheel_command, press as press_command,
    },
    context::CommandContext,
};
use serde_json::Value;

use crate::cli_args::{
    actions::{HoverArgs, KeyComboArgs, MouseClickArgs, MouseMoveArgs, MousePointArgs, PressArgs},
    drag::DragCliArgs,
    mouse_wheel::MouseWheelArgs,
};
use crate::dispatch::parse::{parse_modifiers, parse_mouse_button, parse_xy, parse_xy_opt};

pub(super) fn press(
    args: PressArgs,
    adapter: &dyn PlatformAdapter,
    context: &CommandContext,
) -> Result<Value, AppError> {
    press_command::execute(
        press_command::PressArgs {
            combo: args.combo,
            app: args.app,
            window_id: args.window_id,
            force: args.force,
        },
        adapter,
        context,
    )
}

pub(super) fn key_down(
    args: KeyComboArgs,
    adapter: &dyn PlatformAdapter,
) -> Result<Value, AppError> {
    key_down_command::execute(
        key_down_command::KeyDownArgs {
            combo: args.combo,
            force: args.force,
        },
        adapter,
    )
}

pub(super) fn key_up(args: KeyComboArgs, adapter: &dyn PlatformAdapter) -> Result<Value, AppError> {
    key_up_command::execute(
        key_up_command::KeyUpArgs {
            combo: args.combo,
            force: args.force,
        },
        adapter,
    )
}

pub(super) fn hover(
    args: HoverArgs,
    adapter: &dyn PlatformAdapter,
    context: &CommandContext,
) -> Result<Value, AppError> {
    hover_command::execute(
        hover_command::HoverArgs {
            ref_id: args.ref_id,
            xy: parse_xy_opt(args.xy.as_deref())?,
            duration_ms: args.duration,
            timeout_ms: helpers::normalize_action_timeout_ms(args.timeout_ms),
        },
        adapter,
        context,
    )
}

pub(super) fn drag(
    args: DragCliArgs,
    adapter: &dyn PlatformAdapter,
    context: &CommandContext,
) -> Result<Value, AppError> {
    drag_command::execute(
        drag_command::DragArgs {
            from: drag_command::DragEndpoint {
                ref_id: args.target.from,
                xy: parse_xy_opt(args.target.from_xy.as_deref())?,
            },
            to: drag_command::DragEndpoint {
                ref_id: args.target.to,
                xy: parse_xy_opt(args.target.to_xy.as_deref())?,
            },
            duration_ms: args.duration,
            drop_delay_ms: args.drop_delay,
            timeout_ms: helpers::normalize_action_timeout_ms(args.timeout_ms),
            wait_for_scope: args
                .wait_for_scope
                .map(crate::cli_args::drag::WaitForScopeArg::to_core)
                .unwrap_or_default(),
        },
        adapter,
        context,
    )
}

pub(super) fn mouse_move(
    args: MouseMoveArgs,
    adapter: &dyn PlatformAdapter,
    context: &CommandContext,
) -> Result<Value, AppError> {
    let (x, y) = parse_xy(&args.xy)?;
    mouse_move_command::execute(mouse_move_command::MouseMoveArgs { x, y }, adapter, context)
}

pub(super) fn mouse_click(
    args: MouseClickArgs,
    adapter: &dyn PlatformAdapter,
    context: &CommandContext,
) -> Result<Value, AppError> {
    let (x, y) = parse_xy(&args.xy)?;
    mouse_click_command::execute(
        mouse_click_command::MouseClickArgs {
            x,
            y,
            button: parse_mouse_button(&args.button)?,
            count: args.count,
            modifiers: parse_modifiers(&args.modifiers)?,
        },
        adapter,
        context,
    )
}

pub(super) fn mouse_down(
    args: MousePointArgs,
    adapter: &dyn PlatformAdapter,
    context: &CommandContext,
) -> Result<Value, AppError> {
    let (x, y) = parse_xy(&args.xy)?;
    mouse_down_command::execute(
        mouse_down_command::MouseDownArgs {
            x,
            y,
            button: parse_mouse_button(&args.button)?,
            modifiers: parse_modifiers(&args.modifiers)?,
        },
        adapter,
        context,
    )
}

pub(super) fn mouse_up(
    args: MousePointArgs,
    adapter: &dyn PlatformAdapter,
    context: &CommandContext,
) -> Result<Value, AppError> {
    let (x, y) = parse_xy(&args.xy)?;
    mouse_up_command::execute(
        mouse_up_command::MouseUpArgs {
            x,
            y,
            button: parse_mouse_button(&args.button)?,
            modifiers: parse_modifiers(&args.modifiers)?,
        },
        adapter,
        context,
    )
}

pub(super) fn mouse_wheel(
    args: MouseWheelArgs,
    adapter: &dyn PlatformAdapter,
    context: &CommandContext,
) -> Result<Value, AppError> {
    mouse_wheel_command::execute(
        mouse_wheel_command::MouseWheelArgs {
            x: args.x,
            y: args.y,
            dy: args.vertical_lines(),
            dx: args.dx,
            modifiers: parse_modifiers(&args.modifiers)?,
        },
        adapter,
        context,
    )
}
