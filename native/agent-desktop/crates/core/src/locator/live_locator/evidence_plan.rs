use crate::{AdapterError, ErrorCode};

use super::EvidenceRequirements;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct EvidencePlan {
    root: EvidenceRequirements,
    descendants: EvidenceRequirements,
}

impl EvidencePlan {
    pub(super) fn uniform(requirements: EvidenceRequirements) -> Self {
        Self {
            root: requirements,
            descendants: requirements,
        }
    }

    pub(super) fn rooted(root: EvidenceRequirements, descendants: EvidenceRequirements) -> Self {
        Self { root, descendants }
    }

    pub(super) fn validate(self) -> Result<(), AdapterError> {
        if !self.descendants.role || !self.root.role {
            return Err(AdapterError::new(
                ErrorCode::InvalidArgs,
                "role evidence is required for every observation",
            ));
        }
        if !self.root.covers(self.descendants) {
            return Err(AdapterError::new(
                ErrorCode::InvalidArgs,
                "root evidence must cover descendant evidence",
            ));
        }
        Ok(())
    }

    pub(super) fn for_raw_depth(self, raw_depth: u8) -> EvidenceRequirements {
        if raw_depth == 0 {
            self.root
        } else {
            self.descendants
        }
    }

    pub(super) fn descendants(self) -> EvidenceRequirements {
        self.descendants
    }

    pub(super) fn hydrates_root_name_from_children(self) -> bool {
        self.root != self.descendants && (self.root.name || self.root.description)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn root_evidence_must_cover_descendant_evidence() {
        let error = EvidencePlan::rooted(
            EvidenceRequirements {
                role: true,
                ..EvidenceRequirements::default()
            },
            EvidenceRequirements::snapshot(),
        )
        .validate()
        .unwrap_err();

        assert_eq!(error.code, ErrorCode::InvalidArgs);
    }

    #[test]
    fn root_name_hydration_is_explicit_in_the_plan() {
        let descendants = EvidenceRequirements {
            role: true,
            ..EvidenceRequirements::default()
        };
        let rooted = EvidencePlan::rooted(EvidenceRequirements::snapshot(), descendants);

        assert!(rooted.validate().is_ok());
        assert!(rooted.hydrates_root_name_from_children());
        assert!(!EvidencePlan::uniform(descendants).hydrates_root_name_from_children());
    }
}
