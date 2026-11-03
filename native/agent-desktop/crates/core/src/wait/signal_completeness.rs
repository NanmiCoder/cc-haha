use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct SignalCompleteness {
    pub windows: bool,
    pub apps: bool,
    pub surfaces: bool,
}

impl SignalCompleteness {
    pub const fn complete() -> Self {
        Self {
            windows: true,
            apps: true,
            surfaces: true,
        }
    }
}
