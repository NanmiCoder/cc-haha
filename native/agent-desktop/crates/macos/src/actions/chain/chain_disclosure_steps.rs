#[cfg(target_os = "macos")]
mod imp {
    use crate::actions::chain::chain_delivery::DeliveryOutcome;
    use crate::tree::AXElement;
    use agent_desktop_core::{AdapterError, Deadline};
    use std::time::{Duration, Instant};

    pub(crate) fn press_to_expand(
        element: &AXElement,
        deadline: Deadline,
    ) -> Result<DeliveryOutcome, AdapterError> {
        set_disclosure(element, true, deadline)
    }

    pub(crate) fn press_to_collapse(
        element: &AXElement,
        deadline: Deadline,
    ) -> Result<DeliveryOutcome, AdapterError> {
        set_disclosure(element, false, deadline)
    }

    fn set_disclosure(
        element: &AXElement,
        expanded: bool,
        deadline: Deadline,
    ) -> Result<DeliveryOutcome, AdapterError> {
        let (satisfied, allow_toggle) =
            disclosure_plan(disclosed_state(element, deadline)?, expanded);
        if satisfied {
            return Ok(DeliveryOutcome::SatisfiedNoDelivery);
        }
        let action = if expanded { "AXExpand" } else { "AXCollapse" };
        prepare(element, deadline)?;
        if crate::actions::ax_helpers::try_ax_action_or_err(element, action, deadline)? {
            let outcome = verify_disclosure(element, expanded, deadline).map_err(after_delivery)?;
            if let Some(delivered) = stop_if_delivered(outcome) {
                return Ok(delivered);
            }
        }
        prepare(element, deadline)?;
        if crate::actions::ax_helpers::is_attr_settable(element, "AXExpanded", deadline)? {
            prepare(element, deadline)?;
            if crate::actions::ax_helpers::set_ax_bool_or_err(
                element,
                "AXExpanded",
                expanded,
                deadline,
            )? {
                let outcome =
                    verify_disclosure(element, expanded, deadline).map_err(after_delivery)?;
                if let Some(delivered) = stop_if_delivered(outcome) {
                    return Ok(delivered);
                }
            }
        }
        if allow_toggle && disclosed_state(element, deadline)? == Some(!expanded) {
            prepare(element, deadline)?;
            if crate::actions::ax_helpers::try_ax_action_or_err(element, "AXPress", deadline)? {
                let outcome =
                    verify_disclosure(element, expanded, deadline).map_err(after_delivery)?;
                if let Some(delivered) = stop_if_delivered(outcome) {
                    return Ok(delivered);
                }
            }
        }
        Ok(DeliveryOutcome::NotDelivered)
    }

    fn stop_if_delivered(outcome: DeliveryOutcome) -> Option<DeliveryOutcome> {
        outcome.was_delivered().then_some(outcome)
    }

    fn disclosure_plan(current: Option<bool>, desired: bool) -> (bool, bool) {
        (current == Some(desired), current == Some(!desired))
    }

    fn verify_disclosure(
        element: &AXElement,
        expanded: bool,
        deadline: Deadline,
    ) -> Result<DeliveryOutcome, AdapterError> {
        let local_end = Instant::now() + Duration::from_millis(200);
        loop {
            let current_state = disclosed_state(element, deadline)?;
            match current_state {
                Some(current) if current == expanded => {
                    return Ok(DeliveryOutcome::DeliveredVerified);
                }
                _ => {}
            }
            if deadline.is_expired() {
                return Err(deadline.timeout_error().with_details(serde_json::json!({
                    "verification": "expanded_state_not_observed",
                })));
            }
            if Instant::now() >= local_end {
                return unobserved_delivery(current_state, expanded);
            }
            let pause = deadline.remaining_slice(Duration::from_millis(20))?;
            std::thread::sleep(pause.min(Duration::from_millis(20)));
        }
    }

    fn unobserved_delivery(
        last_state: Option<bool>,
        expanded: bool,
    ) -> Result<DeliveryOutcome, AdapterError> {
        if last_state == Some(!expanded) {
            Err(AdapterError::new(
                agent_desktop_core::ErrorCode::ActionFailed,
                "Disclosure action completed but the requested expanded state was not observed",
            )
            .with_disposition(agent_desktop_core::DeliverySemantics::delivered_unverified())
            .with_suggestion("Inspect the expanded state before deciding whether to retry."))
        } else {
            Ok(DeliveryOutcome::DeliveredUnverified)
        }
    }

    fn disclosed_state(
        element: &AXElement,
        deadline: Deadline,
    ) -> Result<Option<bool>, AdapterError> {
        let instant = crate::tree::locator_deadline::from_operation(deadline)?;
        if let Some(value) = crate::tree::surface_read::boolean(element, "AXExpanded", instant)? {
            return Ok(Some(value));
        }
        if let Some(value) = crate::tree::surface_read::boolean(element, "AXDisclosing", instant)? {
            return Ok(Some(value));
        }
        let role = crate::tree::surface_read::string(element, "AXRole", instant)?;
        if role.as_deref() != Some("AXDisclosureTriangle") {
            return Ok(None);
        }
        let value = crate::tree::properties::attributes::copy_value_typed_result(element, deadline)
            .map_err(|error| {
                crate::tree::query::read_error::semantic_read(error, "disclosure.value")
            })?;
        Ok(crate::tree::state_reader::expanded_state(
            role.as_deref(),
            None,
            value.as_deref(),
        ))
    }

    fn prepare(element: &AXElement, deadline: Deadline) -> Result<(), AdapterError> {
        crate::tree::properties::attributes::set_messaging_timeout(element, deadline)
    }

    fn after_delivery(error: AdapterError) -> AdapterError {
        let mut delivery = crate::actions::DeliveryTracker::default();
        delivery.mark_delivered();
        delivery.annotate(error)
    }

    #[cfg(test)]
    mod tests {
        use super::{DeliveryOutcome, disclosure_plan, stop_if_delivered, unobserved_delivery};

        #[test]
        fn disclosure_plan_never_blindly_toggles_unknown_state() {
            assert_eq!(disclosure_plan(Some(true), true), (true, false));
            assert_eq!(disclosure_plan(Some(false), true), (false, true));
            assert_eq!(disclosure_plan(None, true), (false, false));
            assert_eq!(disclosure_plan(Some(false), false), (true, false));
            assert_eq!(disclosure_plan(Some(true), false), (false, true));
            assert_eq!(disclosure_plan(None, false), (false, false));
        }

        #[test]
        fn unobserved_delivery_preserves_honest_unknown_state() {
            assert_eq!(
                unobserved_delivery(Some(false), true)
                    .expect_err("known opposite state")
                    .disposition,
                agent_desktop_core::DeliverySemantics::delivered_unverified()
            );
            assert_eq!(
                unobserved_delivery(None, true).expect("unreadable state after delivery"),
                DeliveryOutcome::DeliveredUnverified
            );
            assert_eq!(
                stop_if_delivered(
                    unobserved_delivery(None, true).expect("unreadable state after delivery")
                ),
                Some(DeliveryOutcome::DeliveredUnverified)
            );
        }

        #[test]
        fn delivered_outcomes_halt_further_mutation_strategies() {
            assert_eq!(
                stop_if_delivered(DeliveryOutcome::DeliveredUnverified),
                Some(DeliveryOutcome::DeliveredUnverified)
            );
            assert_eq!(
                stop_if_delivered(DeliveryOutcome::DeliveredVerified),
                Some(DeliveryOutcome::DeliveredVerified)
            );
            assert_eq!(stop_if_delivered(DeliveryOutcome::NotDelivered), None);
        }
    }
}

#[cfg(target_os = "macos")]
pub(crate) use imp::{press_to_collapse, press_to_expand};
