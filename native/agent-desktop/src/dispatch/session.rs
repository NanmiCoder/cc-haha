use agent_desktop_core::{
    AppError, CursorOverlayConfig, CursorOverlayControl, PlatformAdapter,
    commands::{cursor_overlay, session},
    context::CommandContext,
};
use serde_json::Value;

use crate::cli_args::session::{SessionAction, SessionArgs};

pub(crate) fn dispatch(
    args: SessionArgs,
    adapter: &dyn PlatformAdapter,
    context: &CommandContext,
) -> Result<Value, AppError> {
    match args.action {
        SessionAction::Start(s) => {
            let show_cursor = s.cursor;
            let mut value = session::execute(session::SessionAction::Start {
                name: s.name,
                no_trace: s.no_trace,
                screenshots: s.screenshots,
            })?;
            if show_cursor {
                show_default_cursor(adapter, &mut value, s.multi_agent)?;
            }
            Ok(value)
        }
        SessionAction::End(e) => {
            let id = resolve_end_session_id(e.id, context.session_id())?;
            if context.session_namespace_is_pinned() && Some(id.as_str()) != context.session_id() {
                return Err(AppError::invalid_input(
                    "A command host cannot end a foreign session",
                ));
            }
            let value = session::execute(session::SessionAction::End { id: id.clone() })?;
            super::cursor_overlay::tear_down(adapter, &CursorOverlayControl::disable(id))?;
            Ok(value)
        }
        SessionAction::List => session::execute(session::SessionAction::List),
        SessionAction::Gc(_) if context.session_namespace_is_pinned() => Err(
            AppError::invalid_input("A command host cannot run global session garbage collection"),
        ),
        SessionAction::Gc(g) => session::execute(session::SessionAction::Gc {
            older_than_secs: g.older_than,
            ended_only: g.ended,
        }),
    }
}

fn show_default_cursor(
    adapter: &dyn PlatformAdapter,
    value: &mut Value,
    multi_agent: bool,
) -> Result<(), AppError> {
    let Some(id) = value
        .get("session_id")
        .and_then(Value::as_str)
        .map(str::to_owned)
    else {
        return Ok(());
    };
    let config = CursorOverlayConfig::enabled(None, 6)?.with_multi_agent(multi_agent);
    let control = CursorOverlayControl::enable(id.clone(), config.style().clone())
        .with_motion(config.motion().clone());
    let enabled = cursor_overlay::execute(
        &id,
        cursor_overlay::CursorOverlayAction::Enable(Box::new(config)),
    )?;
    if let Some(overlay) = enabled.get("cursor_overlay").cloned()
        && let Some(map) = value.as_object_mut()
    {
        map.insert("cursor_overlay".into(), overlay);
    }
    if multi_agent {
        value["rendered"] = Value::Bool(false);
        return Ok(());
    }
    value["rendered"] = Value::Bool(match adapter.update_cursor_overlay(&control) {
        Ok(()) => true,
        Err(error) => {
            super::overlay_skipped::log(&error);
            false
        }
    });
    Ok(())
}

fn resolve_end_session_id(
    explicit: Option<String>,
    active: Option<&str>,
) -> Result<String, AppError> {
    explicit
        .or_else(|| active.map(str::to_string))
        .ok_or_else(|| {
            AppError::invalid_input_with_suggestion(
                "No session id was supplied and no active session scope is configured",
                "Pass `session end <id>`, global `--session <id>`, or AGENT_DESKTOP_SESSION",
            )
        })
}

#[cfg(test)]
#[path = "session_tests.rs"]
mod tests;
