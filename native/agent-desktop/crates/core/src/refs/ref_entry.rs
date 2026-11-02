use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RefEntry {
    #[serde(flatten)]
    pub process: crate::RefProcess,
    #[serde(flatten)]
    pub identity: crate::RefEntryIdentity,
    #[serde(flatten)]
    pub geometry: crate::RefGeometry,
    #[serde(flatten)]
    pub capabilities: crate::RefCapabilities,
    #[serde(flatten)]
    pub source: crate::RefSource,
    #[serde(flatten)]
    pub scope: crate::RefScope,
}
