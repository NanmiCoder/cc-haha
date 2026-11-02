use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LocatorResolutionMeta {
    pub total_matches: u32,
    pub complete: bool,
    pub selection_complete: bool,
    pub truncated: bool,
    pub roles_present: Vec<String>,
}
