use serde::{Deserialize, Serialize};

use crate::{Modifier, MouseButton, MouseEventKind, Point};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MouseEvent {
    pub kind: MouseEventKind,
    pub point: Point,
    pub button: MouseButton,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub modifiers: Vec<Modifier>,
}
