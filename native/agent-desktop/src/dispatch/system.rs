use agent_desktop_core::{
    AppError, PermissionReport, PlatformAdapter,
    commands::{
        permissions as permissions_command, skills as skills_command, wait as wait_command,
        wait_surface::SurfaceWait,
    },
    context::CommandContext,
};
use serde_json::Value;

use crate::cli_args::{
    skills::{SkillsAction, SkillsArgs},
    system::{PermissionsArgs, WaitArgs},
};

pub(super) fn wait(
    args: WaitArgs,
    adapter: &dyn PlatformAdapter,
    context: &CommandContext,
) -> Result<Value, AppError> {
    wait_command::execute(
        wait_command::WaitArgs {
            mode: wait_command::WaitModeArgs {
                ms: args.mode.ms,
                element: args.mode.element,
                window: args.mode.window,
                text: args.mode.text,
                surface: SurfaceWait::from_flags(
                    args.mode.menu,
                    args.mode.menu_closed,
                    args.mode.notification,
                )?,
                event: args.event.event,
                window_id: args.event.window_id,
            },
            predicate: wait_command::WaitPredicateArgs {
                predicate: args.predicate.predicate,
                value: args.predicate.value,
                action: args.predicate.action,
                count: args.predicate.count,
            },
            timeout_ms: args.timeout,
            app: args.app,
        },
        adapter,
        context,
    )
}

pub(super) fn permissions(
    args: PermissionsArgs,
    adapter: &dyn PlatformAdapter,
    permission_report: &PermissionReport,
) -> Result<Value, AppError> {
    permissions_command::execute_with_report(
        permissions_command::PermissionsArgs {
            request: args.request,
            guide: args.guide,
        },
        adapter,
        permission_report,
    )
}

pub(super) fn skills(args: SkillsArgs) -> Result<Value, AppError> {
    match args.action.unwrap_or(SkillsAction::List) {
        SkillsAction::List => skills_command::list(),
        SkillsAction::Path => skills_command::path(),
        SkillsAction::Get(get) => skills_command::get(skills_command::GetArgs {
            name: get.name,
            full: get.full,
            reference: get.reference,
        }),
    }
}
