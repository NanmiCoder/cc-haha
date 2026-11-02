use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RefGeometry {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bounds: Option<crate::Rect>,
    pub bounds_hash: Option<u64>,
    /// The frame `bounds` is measured in. Absent means a screen rectangle,
    /// which older refmaps stored without a tag.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bounds_space: Option<crate::BoundsSpace>,
}
