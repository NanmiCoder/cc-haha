use crate::{IdentifierEvidence, LocatorField};

#[derive(Debug, Clone, PartialEq)]
pub struct LiveIdentity {
    pub name: LocatorField<String>,
    pub description: LocatorField<String>,
    pub identifiers: IdentifierEvidence,
}
