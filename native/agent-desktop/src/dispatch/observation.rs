use agent_desktop_core::{
    AppError, PlatformAdapter,
    commands::{
        find as find_command, get as get_command, is_check as is_command,
        screenshot as screenshot_command, snapshot as snapshot_command,
    },
    context::CommandContext,
};
use serde_json::Value;

use crate::cli_args::{FindArgs, GetArgs, IsArgs, ScreenshotArgs, SnapshotArgs};
use crate::dispatch::parse::{parse_get_property, parse_is_property};

pub(super) fn snapshot(
    args: SnapshotArgs,
    adapter: &dyn PlatformAdapter,
    context: &CommandContext,
) -> Result<Value, AppError> {
    snapshot_command::execute(
        snapshot_command::SnapshotArgs {
            app: args.scope.app,
            window_id: args.scope.window_id,
            max_depth: args.tree.max_depth,
            include_bounds: args.tree.include_bounds,
            interactive_only: args.tree.interactive_only,
            compact: args.tree.compact,
            surface: args.surface.to_core(),
            skeleton: args.tree.skeleton,
            root_ref: args.root,
            timeout_ms: args.timeout_ms,
            force_electron_a11y: args.force_electron_a11y,
        },
        adapter,
        context,
    )
}

pub(super) fn find(
    args: FindArgs,
    adapter: &dyn PlatformAdapter,
    context: &CommandContext,
) -> Result<Value, AppError> {
    let states = args
        .states
        .iter()
        .map(|raw| find_command::parse_state_flag(raw))
        .collect::<Result<Vec<_>, _>>()?;
    find_command::execute(
        find_command::FindArgs {
            app: args.scope.app,
            window_id: args.scope.window_id,
            root: args.root,
            surface: args.surface.to_core(),
            timeout_ms: args.timeout_ms,
            filter: find_command::FindFilterArgs {
                role: args.filter.role,
                name: args.filter.name,
                description: args.filter.description,
                native_id: args.filter.native_id,
                value: args.filter.value,
                text: args.filter.text,
                exact: args.filter.exact,
            },
            states,
            selection: find_command::FindSelectionArgs {
                count: args.selection.count,
                first: args.selection.first,
                last: args.selection.last,
                nth: args.selection.nth,
                limit: args.selection.limit,
            },
        },
        adapter,
        context,
    )
}

pub(super) fn screenshot(
    args: ScreenshotArgs,
    adapter: &dyn PlatformAdapter,
) -> Result<Value, AppError> {
    screenshot_command::execute(
        screenshot_command::ScreenshotArgs {
            app: args.scope.app,
            window_id: args.scope.window_id,
            screen: args.screen,
            output_path: args.output_path,
        },
        adapter,
    )
}

pub(super) fn get(
    args: GetArgs,
    adapter: &dyn PlatformAdapter,
    context: &CommandContext,
) -> Result<Value, AppError> {
    get_command::execute(
        get_command::GetArgs {
            ref_id: args.ref_id,
            property: parse_get_property(&args.property)?,
        },
        adapter,
        context,
    )
}

pub(super) fn is(
    args: IsArgs,
    adapter: &dyn PlatformAdapter,
    context: &CommandContext,
) -> Result<Value, AppError> {
    is_command::execute(
        is_command::IsArgs {
            ref_id: args.ref_id,
            property: parse_is_property(&args.property)?,
        },
        adapter,
        context,
    )
}
