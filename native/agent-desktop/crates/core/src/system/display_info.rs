use serde::{Deserialize, Serialize};

use crate::Rect;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DisplayInfo {
    pub id: String,
    pub bounds: Rect,
    pub is_primary: bool,
    pub scale: f64,
}
