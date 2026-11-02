use super::stacking_snapshot::StackingSnapshot;

/// What a stacking read could say. Anything but `Ready` is the absence of
/// evidence.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum StackingRead {
    Ready(StackingSnapshot),
    NotX11,
    NoManager,
    Unavailable,
}
