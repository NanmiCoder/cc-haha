use serde::{Deserialize, Serialize};

use crate::CursorOverlayConfig;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SessionManifest {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub created_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<u64>,
    #[serde(default)]
    pub trace: SessionTraceMode,
    #[serde(default)]
    pub artifacts: ArtifactsMode,
    #[serde(default, skip_serializing_if = "CursorOverlayConfig::is_disabled")]
    pub cursor_overlay: CursorOverlayConfig,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ArtifactsMode {
    Full,
    #[default]
    Events,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SessionTraceMode {
    On,
    #[default]
    Off,
}

impl SessionManifest {
    pub fn trace_enabled(&self) -> bool {
        matches!(self.trace, SessionTraceMode::On) && self.ended_at.is_none()
    }

    pub fn artifacts_full(&self) -> bool {
        matches!(self.artifacts, ArtifactsMode::Full) && self.ended_at.is_none()
    }
}
