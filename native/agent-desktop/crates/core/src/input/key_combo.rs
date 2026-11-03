use serde::{Deserialize, Serialize};

use crate::Modifier;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KeyCombo {
    pub key: String,
    pub modifiers: Vec<Modifier>,
}
