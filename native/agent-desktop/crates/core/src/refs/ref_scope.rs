use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RefScope {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub root_ref: Option<String>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub path_is_absolute: bool,
    #[serde(default, skip_serializing_if = "smallvec::SmallVec::is_empty")]
    pub path: crate::refs::RefPath,
}

fn is_false(value: &bool) -> bool {
    !*value
}
