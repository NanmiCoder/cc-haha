use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SurfaceInfo {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub item_count: Option<usize>,
    /// Surface kinds that could not be read for this window, so a missing
    /// `sheet` or `menu` entry is not mistaken for an observed absence.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub unclassified: Vec<String>,
}
