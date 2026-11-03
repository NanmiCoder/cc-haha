#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct IdentifierEvidence {
    identifiers: Vec<crate::ElementIdentifier>,
    preferred: Option<usize>,
    complete: bool,
    retained_object: Option<String>,
}

impl IdentifierEvidence {
    pub fn new(
        values: impl IntoIterator<Item = String>,
        preferred: Option<usize>,
        complete: bool,
    ) -> Self {
        Self::typed(
            values.into_iter().map(|value| crate::ElementIdentifier {
                kind: crate::IdentifierKind::Unknown,
                value,
            }),
            preferred,
            complete,
        )
    }

    pub fn typed(
        identifiers: impl IntoIterator<Item = crate::ElementIdentifier>,
        preferred: Option<usize>,
        complete: bool,
    ) -> Self {
        let mut normalized = Vec::new();
        let mut normalized_preferred = None;
        for (index, identifier) in identifiers.into_iter().enumerate() {
            if identifier.value.trim().is_empty() {
                continue;
            }
            let position = normalized
                .iter()
                .position(|candidate| candidate == &identifier);
            if preferred == Some(index) {
                normalized_preferred = Some(position.unwrap_or(normalized.len()));
            }
            if position.is_none() {
                normalized.push(identifier);
            }
        }
        Self {
            identifiers: normalized,
            preferred: normalized_preferred,
            complete,
            retained_object: None,
        }
    }

    pub fn with_retained_object(mut self, token: String) -> Self {
        self.retained_object = Some(token);
        self
    }

    pub fn retained_object(&self) -> Option<&str> {
        self.retained_object.as_deref()
    }

    pub fn absent() -> Self {
        Self::new([], None, true)
    }

    pub fn unknown() -> Self {
        Self::new([], None, false)
    }

    pub fn identifiers(&self) -> &[crate::ElementIdentifier] {
        &self.identifiers
    }

    #[cfg(test)]
    pub fn values(&self) -> Vec<&str> {
        self.identifiers
            .iter()
            .map(|identifier| identifier.value.as_str())
            .collect()
    }

    pub fn preferred_value(&self) -> Option<&str> {
        self.preferred
            .and_then(|index| self.identifiers.get(index))
            .map(|identifier| identifier.value.as_str())
    }

    pub fn preferred_identifier(&self) -> Option<&crate::ElementIdentifier> {
        self.preferred.and_then(|index| self.identifiers.get(index))
    }

    pub fn preferred_index(&self) -> Option<usize> {
        self.preferred
    }

    pub fn is_complete(&self) -> bool {
        self.complete
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preferred_index_is_resolved_before_empty_values_are_removed() {
        let evidence = IdentifierEvidence::new([String::new(), "dom-id".into()], Some(1), true);

        assert_eq!(evidence.values(), ["dom-id"]);
        assert_eq!(evidence.preferred_index(), Some(0));
        assert_eq!(evidence.preferred_value(), Some("dom-id"));
    }

    #[test]
    fn preferred_duplicate_maps_to_the_deduplicated_value() {
        let later = IdentifierEvidence::new(
            ["shared".into(), "other".into(), "shared".into()],
            Some(2),
            true,
        );

        assert_eq!(later.values(), ["shared", "other"]);
        assert_eq!(later.preferred_index(), Some(0));
        assert_eq!(later.preferred_value(), Some("shared"));

        let first = IdentifierEvidence::new(
            [
                "automation-id".into(),
                "runtime-id".into(),
                "automation-id".into(),
            ],
            Some(0),
            true,
        );

        assert_eq!(first.values(), ["automation-id", "runtime-id"]);
        assert_eq!(first.preferred_value(), Some("automation-id"));
        assert!(first.is_complete());
    }
}
