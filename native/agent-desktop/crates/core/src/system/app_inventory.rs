use crate::AppInfo;

#[derive(Debug, Clone)]
pub struct AppInventory {
    pub apps: Vec<AppInfo>,
    pub skipped: Vec<serde_json::Value>,
}
