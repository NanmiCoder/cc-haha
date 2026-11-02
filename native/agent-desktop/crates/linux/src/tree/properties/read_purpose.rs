/// Fields needed by one fresh observation; omitted fields remain unknown.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum ReadPurpose {
    Snapshot,
    Sampling,
    Identity,
    Resolve,
    Element,
    State,
    Bounds,
    Value,
    Actions,
    Frame,
    Structure,
    Shape,
    Gate,
}

impl ReadPurpose {
    pub(in crate::tree) fn identity(self) -> bool {
        matches!(
            self,
            Self::Snapshot | Self::Sampling | Self::Identity | Self::Resolve | Self::Element
        )
    }

    pub(in crate::tree) fn vocabulary(self) -> bool {
        self.identity() || matches!(self, Self::State | Self::Actions | Self::Value)
    }

    pub(in crate::tree) fn value(self) -> bool {
        self.identity() || matches!(self, Self::State | Self::Value)
    }

    pub(in crate::tree) fn bounds(self) -> bool {
        (self.identity() && self != Self::Sampling)
            || matches!(self, Self::State | Self::Bounds | Self::Frame)
    }

    pub(in crate::tree) fn actions(self) -> bool {
        matches!(
            self,
            Self::Snapshot | Self::Sampling | Self::Element | Self::Actions
        )
    }

    pub(in crate::tree) fn children(self) -> bool {
        matches!(
            self,
            Self::Snapshot
                | Self::Sampling
                | Self::Structure
                | Self::Shape
                | Self::Gate
                | Self::Resolve
        )
    }
}

#[cfg(test)]
#[path = "read_purpose_tests.rs"]
mod tests;
