use agent_desktop_core::{AppError, commands::trace, context::CommandContext};
use serde_json::Value;

use crate::cli_args::trace::{TraceAction, TraceArgs};

pub(crate) fn dispatch(args: TraceArgs, context: &CommandContext) -> Result<Value, AppError> {
    match args.action {
        TraceAction::Show(show) => trace::execute(
            trace::TraceAction::Show {
                limit: show.limit,
                event: show.event,
            },
            context,
        ),
        TraceAction::Export(export) => trace::execute(
            trace::TraceAction::Export {
                limit: export.limit,
                out: export.out,
            },
            context,
        ),
    }
}
