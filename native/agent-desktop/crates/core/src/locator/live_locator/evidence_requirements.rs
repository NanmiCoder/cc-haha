use crate::locator::LocatorQuery;

use super::{LocatorMaterialization, LocatorResolveRequest, RefEvidenceRequirements};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct EvidenceRequirements {
    pub role: bool,
    pub name: bool,
    pub description: bool,
    pub value: bool,
    pub identifiers: bool,
    pub states: bool,
    pub ref_evidence: RefEvidenceRequirements,
}

impl EvidenceRequirements {
    pub fn snapshot() -> Self {
        Self {
            role: true,
            name: true,
            description: true,
            value: true,
            identifiers: true,
            states: true,
            ref_evidence: RefEvidenceRequirements {
                bounds: true,
                actions: true,
            },
        }
    }

    pub(crate) fn locator(query: &LocatorQuery, request: &LocatorResolveRequest) -> Self {
        if request.materialization == LocatorMaterialization::FullRefMap {
            return Self::snapshot();
        }
        let mut requirements = Self::query(query);
        if request.materialization == LocatorMaterialization::SelectedMatches {
            requirements.identifiers = true;
            requirements.ref_evidence.bounds = true;
        }
        requirements
    }

    pub(crate) fn query(query: &LocatorQuery) -> Self {
        let needs_subtree_text = query.has_text.is_some();
        let mut requirements = Self {
            role: true,
            name: query.identity.name.is_some() || needs_subtree_text,
            description: query.identity.description.is_some() || needs_subtree_text,
            value: query.identity.value.is_some() || needs_subtree_text,
            identifiers: query.identity.native_id.is_some(),
            states: !query.states.is_empty(),
            ref_evidence: RefEvidenceRequirements::default(),
        };
        for nested in [
            query.containment.has.as_deref(),
            query.containment.has_not.as_deref(),
        ]
        .into_iter()
        .flatten()
        {
            requirements = requirements.union(Self::query(nested));
        }
        requirements
    }

    fn union(self, other: Self) -> Self {
        Self {
            role: self.role || other.role,
            name: self.name || other.name,
            description: self.description || other.description,
            value: self.value || other.value,
            identifiers: self.identifiers || other.identifiers,
            states: self.states || other.states,
            ref_evidence: self.ref_evidence.union(other.ref_evidence),
        }
    }

    pub(super) fn covers(self, other: Self) -> bool {
        self.union(other) == self
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::locator::live_locator::LocatorSelection;

    #[test]
    fn selected_matches_use_typed_identifiers_and_bounds_without_global_semantic_reads() {
        let query = LocatorQuery {
            identity: crate::IdentityPredicate {
                role: Some("button".into()),
                ..Default::default()
            },
            ..Default::default()
        };
        let request = LocatorResolveRequest {
            selection: LocatorSelection::First,
            deadline: crate::Deadline::after(500).unwrap(),
            max_raw_depth: 50,
            surface: None,
            materialization: LocatorMaterialization::SelectedMatches,
        };

        let requirements = EvidenceRequirements::locator(&query, &request);

        assert!(requirements.role);
        assert!(!requirements.name);
        assert!(!requirements.description);
        assert!(!requirements.value);
        assert!(requirements.identifiers);
        assert!(requirements.ref_evidence.bounds);
        assert!(!requirements.states);
        assert!(!requirements.ref_evidence.actions);
    }
}
