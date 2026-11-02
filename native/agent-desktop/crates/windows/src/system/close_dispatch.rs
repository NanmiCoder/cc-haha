#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CloseDispatch {
    Sent,
    AlreadyGone,
}
