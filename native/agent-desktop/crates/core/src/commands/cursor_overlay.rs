use crate::{AppError, CursorOverlayConfig, session::set_cursor_overlay};
use serde_json::{Value, json};

#[derive(Debug, Clone)]
pub enum CursorOverlayAction {
    Enable(Box<CursorOverlayConfig>),
    Disable,
}

pub fn execute(session_id: &str, action: CursorOverlayAction) -> Result<Value, AppError> {
    let (cursor_overlay, next) = match action {
        CursorOverlayAction::Enable(config) => {
            (*config, Some(super::session::activation_export(session_id)))
        }
        CursorOverlayAction::Disable => (CursorOverlayConfig::default(), None),
    };
    let manifest = set_cursor_overlay(session_id, cursor_overlay)?;
    let mut response = json!({
        "session_id": manifest.id,
        "cursor_overlay": manifest.cursor_overlay,
    });
    if let Some(next) = next {
        response["next"] = next.into();
        response["activation"] = super::session::activation(session_id);
    }
    Ok(response)
}

#[cfg(test)]
#[path = "cursor_overlay_tests.rs"]
mod tests;
