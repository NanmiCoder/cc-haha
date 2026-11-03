use serde::{Deserialize, Serialize};

/// The frame a stored or live rectangle is measured in. Screen rectangles move
/// with the window on some toolkits and are not reported at all on a Wayland
/// session, so only their size is stable evidence. A window rectangle does not
/// move when the window does, so its whole rectangle can identify an element.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BoundsSpace {
    #[default]
    Screen,
    Window,
}
