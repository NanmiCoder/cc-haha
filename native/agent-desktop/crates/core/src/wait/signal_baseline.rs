use crate::{AppInfo, SignalCompleteness, SurfaceSignal, WindowInfo};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SignalBaseline {
    pub windows: Vec<WindowInfo>,
    pub apps: Vec<AppInfo>,
    pub surfaces: Vec<SurfaceSignal>,
    pub completeness: SignalCompleteness,
}
