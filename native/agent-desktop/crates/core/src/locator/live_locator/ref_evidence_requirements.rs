#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct RefEvidenceRequirements {
    pub bounds: bool,
    pub actions: bool,
}

impl RefEvidenceRequirements {
    pub(crate) fn union(self, other: Self) -> Self {
        Self {
            bounds: self.bounds || other.bounds,
            actions: self.actions || other.actions,
        }
    }
}
