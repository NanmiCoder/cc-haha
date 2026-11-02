#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum DeliveryOutcome {
    NotDelivered,
    SatisfiedNoDelivery,
    DeliveredUnverified,
    DeliveredWithoutEffect,
    DeliveredVerified,
}

impl DeliveryOutcome {
    pub(crate) fn from_delivery(delivered: bool, verified: bool) -> Self {
        match (delivered, verified) {
            (false, _) => Self::NotDelivered,
            (true, false) => Self::DeliveredUnverified,
            (true, true) => Self::DeliveredVerified,
        }
    }

    pub(crate) fn was_delivered(self) -> bool {
        matches!(
            self,
            Self::DeliveredUnverified | Self::DeliveredWithoutEffect | Self::DeliveredVerified
        )
    }

    pub(crate) fn was_verified(self) -> bool {
        matches!(self, Self::SatisfiedNoDelivery | Self::DeliveredVerified)
    }

    /// A step that reached the application and provably changed nothing is the
    /// one delivery that must not end the chain. Unverified delivery stops it
    /// because a second mutation could double-act on an effect nobody saw;
    /// here the absence of the effect is the observation, so the remaining
    /// steps are the only way the caller's request can still be satisfied.
    pub(crate) fn terminates_chain(self) -> bool {
        !matches!(self, Self::NotDelivered | Self::DeliveredWithoutEffect)
    }
}

#[cfg(test)]
mod tests {
    use super::DeliveryOutcome;

    #[test]
    fn delivery_and_verification_are_independent() {
        assert_eq!(
            DeliveryOutcome::from_delivery(false, true),
            DeliveryOutcome::NotDelivered
        );
        assert_eq!(
            DeliveryOutcome::from_delivery(true, false),
            DeliveryOutcome::DeliveredUnverified
        );
        assert_eq!(
            DeliveryOutcome::from_delivery(true, true),
            DeliveryOutcome::DeliveredVerified
        );
        assert!(DeliveryOutcome::SatisfiedNoDelivery.terminates_chain());
        assert!(!DeliveryOutcome::SatisfiedNoDelivery.was_delivered());
        assert!(DeliveryOutcome::SatisfiedNoDelivery.was_verified());
    }

    #[test]
    fn a_delivery_observed_to_change_nothing_continues_the_chain() {
        let outcome = DeliveryOutcome::DeliveredWithoutEffect;

        assert!(outcome.was_delivered());
        assert!(!outcome.was_verified());
        assert!(!outcome.terminates_chain());
        assert!(DeliveryOutcome::DeliveredUnverified.terminates_chain());
    }
}
