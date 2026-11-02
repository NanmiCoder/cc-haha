use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum Direction {
    Up,
    Down,
    Left,
    Right,
}
