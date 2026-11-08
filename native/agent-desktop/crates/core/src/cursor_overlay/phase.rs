use serde::{Deserialize, Serialize};

/// Which half of an action a cursor instruction represents.
///
/// `Travel` is sent before an action and acknowledged once the cursor lands.
/// `Drag` arms pointer tracking and is acknowledged once the renderer is ready.
/// `Effect` is sent after dispatch; the renderer acknowledges it, and the
/// action result does not depend on that acknowledgement.
/// `Caret` places the agent's text caret at the instruction's target, where
/// the app is inserting text; the cursor stays where it is. It is
/// acknowledged like `Effect`, so the renderer reads it before the sender
/// closes the connection.
/// `CaretFollow` moves a caret that is already showing to the instruction's
/// target, or hides it when the instruction has none, after a key press may
/// have moved the insertion point. It never shows a caret that is not showing,
/// and it is acknowledged like `Caret`.
#[derive(Debug, Clone, Copy, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CursorPhase {
    #[default]
    Travel,
    Drag,
    Effect,
    Caret,
    CaretFollow,
}
