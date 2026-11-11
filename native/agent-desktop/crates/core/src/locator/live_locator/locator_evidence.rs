use super::{EvidenceRequirements, IdentifierEvidence, LocatorField, LocatorRefEvidence};

#[derive(Debug, Clone, PartialEq)]
pub struct LocatorEvidence {
    pub role: LocatorField<String>,
    pub name: LocatorField<String>,
    pub description: LocatorField<String>,
    pub value: LocatorField<String>,
    pub identifiers: IdentifierEvidence,
    pub states: LocatorField<Vec<String>>,
    pub ref_evidence: LocatorRefEvidence,
}

impl LocatorEvidence {
    pub fn satisfies(&self, requirements: EvidenceRequirements) -> bool {
        (!requirements.role || !self.role.is_unknown())
            && (!requirements.name || !self.name.is_unknown())
            && (!requirements.description || !self.description.is_unknown())
            && (!requirements.value || !self.value.is_unknown())
            && (!requirements.identifiers || self.identifiers.is_complete())
            && (!requirements.states || !self.states.is_unknown())
            && (!requirements.ref_evidence.bounds || !self.ref_evidence.bounds.is_unknown())
            && (!requirements.ref_evidence.actions
                || !self.ref_evidence.available_actions.is_unknown())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_requirements_reject_unknown_identity_and_ref_evidence() {
        let mut evidence =
            crate::locator::live_locator::test_support::evidence("button", Some("Save"));
        assert!(evidence.satisfies(EvidenceRequirements::snapshot()));

        evidence.name = LocatorField::Unknown;
        assert!(!evidence.satisfies(EvidenceRequirements::snapshot()));
        evidence.name = LocatorField::Known("Save".into());
        evidence.ref_evidence.bounds = LocatorField::Unknown;
        assert!(!evidence.satisfies(EvidenceRequirements::snapshot()));
    }
}
