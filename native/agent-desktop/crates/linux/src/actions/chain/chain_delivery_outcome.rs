use super::chain_observed::Observed;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DeliveryOutcome {
    NotDelivered,
    Satisfied,
    Delivered(Observed),
}
