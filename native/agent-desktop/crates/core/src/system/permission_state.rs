#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum PermissionState {
    Granted,
    Denied { suggestion: String },
    NotRequired,
    Unknown,
}
