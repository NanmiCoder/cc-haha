use crate::LocatorQuery;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct ContainmentPredicate {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub has: Option<Box<LocatorQuery>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub has_not: Option<Box<LocatorQuery>>,
}
