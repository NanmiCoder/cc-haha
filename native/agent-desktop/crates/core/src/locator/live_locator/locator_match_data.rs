use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LocatorMatchData {
    pub ref_id: Option<String>,
    pub role: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub name: String,
    pub value: Option<String>,
    pub states: Vec<String>,
    pub interactive: bool,
    pub path: Vec<String>,
}
