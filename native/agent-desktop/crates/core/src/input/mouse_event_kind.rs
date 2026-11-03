use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum MouseEventKind {
    Move,
    Down,
    Up,
    Click { count: u32 },
    Wheel { delta_x: f64, delta_y: f64 },
}
