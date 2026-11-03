use crate::actions::chain::chain_delivery::DeliveryOutcome;

/// `AXPress` on a row or a cell means "select me", and a grid that is not the
/// key view accepts it, answers `kAXErrorSuccess`, and selects nothing. The
/// responder is not lying about reaching the application, only about what
/// happened there, so reading the selection back is what tells the two apart.
/// A selection that is still false is evidence of a delivery with no effect,
/// which is the one result that lets the chain go on to write the container's
/// selection instead of reporting a success the caller cannot see. An element
/// that publishes no selection at all is unchanged: absence of evidence stops
/// the chain exactly as it does today.
fn outcome_from_selection(pressed: DeliveryOutcome, selected: Option<bool>) -> DeliveryOutcome {
    if pressed != DeliveryOutcome::DeliveredUnverified {
        return pressed;
    }
    match selected {
        Some(true) => DeliveryOutcome::DeliveredVerified,
        Some(false) => DeliveryOutcome::DeliveredWithoutEffect,
        None => pressed,
    }
}

#[cfg(target_os = "macos")]
mod imp {
    use agent_desktop_core::{AdapterError, Deadline};

    use super::outcome_from_selection;
    use crate::actions::chain::chain_delivery::DeliveryOutcome;
    use crate::tree::AXElement;

    pub(crate) fn press_or_report_no_effect(
        element: &AXElement,
        deadline: Deadline,
    ) -> Result<DeliveryOutcome, AdapterError> {
        let pressed =
            crate::actions::ax_helpers::perform_observed_action(element, "AXPress", deadline)?;
        if pressed != DeliveryOutcome::DeliveredUnverified {
            return Ok(pressed);
        }
        Ok(outcome_from_selection(
            pressed,
            selection_after_press(element, deadline),
        ))
    }

    /// A selection appears a moment after the press that caused it. Reading it
    /// once calls a press that worked an effectless one, and the chain then
    /// writes a selection that was already on its way. The wait is the same
    /// bounded one the container write uses, and it ends the instant the
    /// selection turns on.
    fn selection_after_press(element: &AXElement, deadline: Deadline) -> Option<bool> {
        if !crate::actions::select::container_select::element_activates_by_selection(
            element, deadline,
        ) {
            return None;
        }
        let settle_end = std::time::Instant::now()
            + std::time::Duration::from_millis(
                crate::actions::select::container_select::SELECTION_SETTLE_MS,
            );
        loop {
            let observed = crate::tree::properties::attributes::copy_bool_attr_result(
                element,
                crate::actions::select::container_select::SELECTED,
                deadline,
            )
            .ok()
            .flatten();
            if observed != Some(false)
                || deadline.is_expired()
                || std::time::Instant::now() >= settle_end
            {
                return observed;
            }
            std::thread::sleep(deadline.remaining().min(std::time::Duration::from_millis(
                crate::actions::select::container_select::SELECTION_POLL_MS,
            )));
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    use agent_desktop_core::{AdapterError, Deadline};

    use crate::actions::chain::chain_delivery::DeliveryOutcome;
    use crate::tree::AXElement;

    pub(crate) fn press_or_report_no_effect(
        _element: &AXElement,
        _deadline: Deadline,
    ) -> Result<DeliveryOutcome, AdapterError> {
        Ok(DeliveryOutcome::NotDelivered)
    }
}

pub(crate) use imp::press_or_report_no_effect;

#[cfg(test)]
mod tests {
    use super::{DeliveryOutcome, outcome_from_selection};

    #[test]
    fn a_press_that_left_the_selection_false_is_a_delivery_without_effect() {
        assert_eq!(
            outcome_from_selection(DeliveryOutcome::DeliveredUnverified, Some(false)),
            DeliveryOutcome::DeliveredWithoutEffect
        );
    }

    #[test]
    fn a_press_that_selected_the_target_is_verified_rather_than_merely_delivered() {
        assert_eq!(
            outcome_from_selection(DeliveryOutcome::DeliveredUnverified, Some(true)),
            DeliveryOutcome::DeliveredVerified
        );
    }

    #[test]
    fn an_element_without_a_selection_keeps_todays_unverified_delivery() {
        assert_eq!(
            outcome_from_selection(DeliveryOutcome::DeliveredUnverified, None),
            DeliveryOutcome::DeliveredUnverified
        );
    }

    #[test]
    fn a_selection_read_never_upgrades_or_downgrades_a_settled_outcome() {
        for pressed in [
            DeliveryOutcome::NotDelivered,
            DeliveryOutcome::SatisfiedNoDelivery,
            DeliveryOutcome::DeliveredVerified,
        ] {
            for selected in [Some(true), Some(false), None] {
                assert_eq!(outcome_from_selection(pressed, selected), pressed);
            }
        }
    }
}
