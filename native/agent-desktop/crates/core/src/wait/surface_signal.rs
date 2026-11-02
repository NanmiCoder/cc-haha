use crate::{ProcessId, snapshot::snapshot_surface::SnapshotSurface};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SurfaceSignal {
    pub kind: SnapshotSurface,
    pub app: String,
    pub pid: ProcessId,
    pub process_instance: String,
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}
