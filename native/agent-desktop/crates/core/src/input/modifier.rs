use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum Modifier {
    #[serde(alias = "Cmd")]
    Meta,
    Ctrl,
    Alt,
    Shift,
}
