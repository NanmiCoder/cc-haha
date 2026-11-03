use serde::{Deserialize, Serialize};

use crate::{ProcessId, Rect, WindowState};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WindowInfo {
    pub id: String,
    pub title: String,
    #[serde(rename = "app_name")]
    pub app: String,
    pub pid: ProcessId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub process_instance: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bounds: Option<Rect>,
    #[serde(flatten)]
    pub state: WindowState,
}

#[cfg(test)]
#[path = "window_info_tests.rs"]
mod tests;
