use super::candidate::Candidate;

/// What a search over a finished walk found and whether any region of the
/// tree stayed unread.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Searched {
    pub(crate) candidates: Vec<Candidate>,
    pub(crate) unread_region: bool,
}
