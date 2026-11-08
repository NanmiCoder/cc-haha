use agent_desktop_core::AdapterError;

#[cfg(target_os = "macos")]
mod imp {
    use super::*;
    use crate::actions::ax_mutation;
    use crate::tree::AXElement;
    use core_foundation::{base::TCFType, string::CFString};

    /// Decides delivery from what the application did, not what it claimed.
    /// Unadvertised actions are never performed, because a responder can answer
    /// `kAXErrorSuccess` to an action it never published and never ran. Only an
    /// uninformative code needs the settle poll to decide delivery at all; a
    /// reported success is already delivered, so observing it merely upgrades
    /// the report to verified and must not cost the caller a wait.
    pub(crate) fn perform_observed_action(
        el: &AXElement,
        name: &str,
        deadline: agent_desktop_core::Deadline,
    ) -> Result<crate::actions::chain::chain_delivery::DeliveryOutcome, AdapterError> {
        use crate::actions::activation_effect;
        use crate::actions::chain::chain_delivery::DeliveryOutcome;
        use ax_mutation::PerformSignal;

        if advertises_action(el, name, deadline) == Some(false) {
            return Ok(DeliveryOutcome::NotDelivered);
        }
        let before = activation_effect::focus_state(el, deadline);
        let action = CFString::new(name);
        let error = crate::tree::properties::ax_ipc::perform_action(
            el,
            action.as_concrete_TypeRef(),
            deadline,
        )?;
        let signal = match ax_mutation::classify_perform(name, error) {
            Ok(signal) => signal,
            Err(failure)
                if failure.disposition == agent_desktop_core::DeliverySemantics::uncertain() =>
            {
                return ax_mutation::settle_uninformative_perform(
                    name,
                    error,
                    activation_effect::settled_change(&before, el, deadline),
                )
                .map_err(|_| failure);
            }
            Err(failure) => return Err(failure),
        };
        match signal {
            PerformSignal::ReportedUnsupported => Ok(DeliveryOutcome::NotDelivered),
            PerformSignal::ReportedDelivered => Ok(DeliveryOutcome::from_delivery(
                true,
                activation_effect::changed_now(&before, el, deadline),
            )),
            PerformSignal::Uninformative => ax_mutation::settle_uninformative_perform(
                name,
                error,
                activation_effect::settled_change(&before, el, deadline),
            ),
        }
    }

    pub(crate) fn advertises_action(
        el: &AXElement,
        name: &str,
        deadline: agent_desktop_core::Deadline,
    ) -> Option<bool> {
        let mut usage = crate::tree::observation_usage::ObservationUsage::with_defaults();
        let read = crate::tree::properties::capabilities::copy_action_names_with_status(
            el,
            std::time::Instant::now() + deadline.remaining(),
            &mut usage,
        );
        read.value
            .map(|actions| actions.iter().any(|action| action == name))
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    use super::*;
    use crate::tree::AXElement;

    pub fn advertises_action(
        _el: &AXElement,
        _name: &str,
        _deadline: agent_desktop_core::Deadline,
    ) -> Option<bool> {
        None
    }

    pub fn perform_observed_action(
        _el: &AXElement,
        _name: &str,
        _deadline: agent_desktop_core::Deadline,
    ) -> Result<crate::actions::chain::chain_delivery::DeliveryOutcome, AdapterError> {
        Ok(crate::actions::chain::chain_delivery::DeliveryOutcome::NotDelivered)
    }
}

pub(crate) use imp::{advertises_action, perform_observed_action};
