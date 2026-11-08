/// Presentation matching includes display-name substrings and exact aliases;
/// mutation lookup requires an exact identifier and optional bundle identity.
#[derive(Debug, Clone, Copy)]
pub enum AppInventoryQuery<'a> {
    All,
    NameOrAlias(&'a str),
    Exact {
        name: &'a str,
        bundle_id: Option<&'a str>,
    },
}

impl AppInventoryQuery<'_> {
    /// Matches the listed name; adapters add their verified exact aliases.
    pub fn matches_display_name(self, actual: &str) -> bool {
        match self {
            Self::All => true,
            Self::NameOrAlias(name) => crate::tree::search_text::contains(
                actual,
                &crate::tree::search_text::normalize(name),
            ),
            Self::Exact { name, .. } => crate::app_name_matches(actual, name),
        }
    }
}

#[cfg(test)]
#[path = "app_inventory_query_tests.rs"]
mod tests;
