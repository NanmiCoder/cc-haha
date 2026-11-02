use serde::{Deserialize, Serialize};

#[cfg(test)]
use crate::{AppInfo, Rect};
use crate::{NodeIdentity, NodePresentation};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AccessibilityNode {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ref_id: Option<String>,

    pub role: String,

    #[serde(flatten)]
    pub identity: NodeIdentity,

    #[serde(flatten)]
    pub presentation: NodePresentation,

    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub children_count: Option<u32>,

    /// Set when this node's descendants were cut short. Skeleton mode also
    /// carries `children_count`; budget or deadline exhaustion cannot afford
    /// the child-count read that would produce one, so the flag is the only
    /// honest marker available on that path.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub subtree_truncated: bool,

    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub children: Vec<AccessibilityNode>,
}

#[cfg(test)]
#[path = "node_tests.rs"]
mod tests;
