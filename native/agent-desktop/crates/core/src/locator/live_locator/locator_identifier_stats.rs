use serde::Serialize;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct LocatorIdentifierStats {
    pub values_observed: u64,
    pub nodes_with_identifiers: u64,
    pub nodes_with_multiple_identifiers: u64,
    pub preferred_matches: u64,
    pub fallback_matches: u64,
}
