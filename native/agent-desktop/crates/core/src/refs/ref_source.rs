use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RefSource {
    pub source_app: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_window_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_window_title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_window_bounds_hash: Option<u64>,
    #[serde(default, skip_serializing_if = "crate::SnapshotSurface::is_window")]
    pub source_surface: crate::SnapshotSurface,
}
