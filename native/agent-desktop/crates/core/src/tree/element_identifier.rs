use serde::{Deserialize, Serialize};

use crate::IdentifierKind;

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct ElementIdentifier {
    pub kind: IdentifierKind,
    pub value: String,
}
