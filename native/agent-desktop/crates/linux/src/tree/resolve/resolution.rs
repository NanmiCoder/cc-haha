/// What the candidates of a search mean for the ref.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Verdict {
    /// The candidate at this index is the element.
    Resolved(usize),
    /// Every region was read and nothing answers to the stored evidence.
    Stale,
    /// Two or more candidates answer and nothing separates them.
    Ambiguous,
    /// A region could not be read, so the answer is withheld.
    Incomplete,
}
