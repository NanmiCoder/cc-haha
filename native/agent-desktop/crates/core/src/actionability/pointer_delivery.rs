#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PointerDelivery {
    NotApplicable,
    Semantic,
    Physical,
}
