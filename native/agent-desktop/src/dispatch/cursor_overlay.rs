use agent_desktop_core::{
    AppError, CursorOverlayControl, PlatformAdapter, commands::cursor_overlay,
    context::CommandContext,
};
use serde_json::Value;

use crate::cli_args::{
    cursor_overlay::CursorOverlayArgs, cursor_overlay_action::CursorOverlayAction,
};

pub(crate) fn dispatch(
    args: CursorOverlayArgs,
    adapter: &dyn PlatformAdapter,
    context: &CommandContext,
) -> Result<Value, AppError> {
    let session_id = context.session_id().ok_or_else(|| {
        AppError::invalid_input_with_suggestion(
            "Cursor overlay settings require an active session",
            "Run `session start`, then pass its id with --session or AGENT_DESKTOP_SESSION.",
        )
    })?;
    let (action, control) = match args.action {
        CursorOverlayAction::Enable(args) => {
            let multi_agent = args.multi_agent || context.multi_agent();
            let config = args.to_core()?.with_multi_agent(multi_agent);
            let agent_id = context.agent_id().map(str::to_owned);
            if let Some(agent_id) = agent_id.as_deref() {
                if args.multi_agent {
                    return Err(AppError::invalid_input(
                        "--multi-agent configures the session; omit --agent-id",
                    ));
                }
                agent_desktop_core::session::save_cursor_overlay_profile(
                    session_id,
                    agent_id,
                    config.clone(),
                )?;
                return Ok(serde_json::json!({
                    "session_id": session_id,
                    "cursor_overlay": config,
                    "agent_id": agent_id,
                }));
            }
            let control =
                CursorOverlayControl::enable(session_id.to_owned(), config.style().clone())
                    .with_motion(config.motion().clone());
            (
                cursor_overlay::CursorOverlayAction::Enable(Box::new(config)),
                (!multi_agent).then_some(control),
            )
        }
        CursorOverlayAction::Disable => (
            cursor_overlay::CursorOverlayAction::Disable,
            Some(CursorOverlayControl::disable(session_id.to_owned())),
        ),
    };
    let mut value = cursor_overlay::execute(session_id, action)?;
    if let Some(control) = control {
        let is_enable = control.is_enable();
        let rendered = match adapter.update_cursor_overlay(&control) {
            Ok(()) => true,
            Err(error) => {
                if control.is_disable() && !nothing_to_tear_down(&error) {
                    return Err(teardown_error(error));
                }
                super::overlay_skipped::log(&error);
                false
            }
        };
        if is_enable {
            value["rendered"] = Value::from(rendered);
        }
    }
    Ok(value)
}

fn nothing_to_tear_down(error: &agent_desktop_core::AdapterError) -> bool {
    error.code == agent_desktop_core::ErrorCode::PlatformNotSupported
}

pub(super) fn tear_down(
    adapter: &dyn PlatformAdapter,
    control: &CursorOverlayControl,
) -> Result<(), AppError> {
    match adapter.update_cursor_overlay(control) {
        Err(error) if !nothing_to_tear_down(&error) => Err(teardown_error(error)),
        _ => Ok(()),
    }
}

pub(super) fn teardown_error(mut error: agent_desktop_core::AdapterError) -> AppError {
    error.message = format!(
        "Session state was saved, but cursor teardown was not confirmed: {}",
        error.message
    );
    error
        .with_disposition(agent_desktop_core::DeliverySemantics::uncertain())
        .into()
}

#[cfg(test)]
#[path = "cursor_overlay_tests.rs"]
mod tests;
