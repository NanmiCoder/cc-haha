#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Observed {
    Matched,
    Unchanged,
    Unread,
}
