/// What a failed read of one field means for the read of its node.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ReadFailure {
    AppGone,
    ObjectGone,
    Failed,
}
