#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Sent {
    Delivered,
    AlreadyGone,
    Replaced,
}
