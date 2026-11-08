#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum MatchVerdict {
    Match,
    NoMatch,
    Unknown,
}

impl MatchVerdict {
    pub(crate) fn and(self, other: Self) -> Self {
        match (self, other) {
            (Self::NoMatch, _) | (_, Self::NoMatch) => Self::NoMatch,
            (Self::Match, Self::Match) => Self::Match,
            _ => Self::Unknown,
        }
    }

    pub(crate) fn or(self, other: Self) -> Self {
        match (self, other) {
            (Self::Match, _) | (_, Self::Match) => Self::Match,
            (Self::NoMatch, Self::NoMatch) => Self::NoMatch,
            _ => Self::Unknown,
        }
    }

    pub(crate) fn negate(self) -> Self {
        match self {
            Self::Match => Self::NoMatch,
            Self::NoMatch => Self::Match,
            Self::Unknown => Self::Unknown,
        }
    }
}
