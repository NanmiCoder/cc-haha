use serde::Serialize;

use super::{LocatorReadCounts, LocatorReadHealth};

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct LocatorReadStats {
    #[serde(flatten)]
    pub counts: LocatorReadCounts,
    #[serde(flatten)]
    pub health: LocatorReadHealth,
}
