#[cfg(target_os = "macos")]
mod imp {
    use agent_desktop_core::{AdapterError, Deadline};

    use crate::actions::{ax_helpers, chain::chain_delivery::DeliveryOutcome, chain::chain_verify};
    use crate::tree::AXElement;

    pub(crate) fn set_dynamic_verified(
        element: &AXElement,
        attribute: &str,
        value: &str,
        deadline: Deadline,
    ) -> Result<DeliveryOutcome, AdapterError> {
        prepare(element, deadline)?;
        let uncertain = if attribute == "AXValue" {
            ax_helpers::set_ax_value_coerced(element, value, deadline).err()
        } else {
            ax_helpers::set_ax_string_or_err(element, attribute, value, deadline).err()
        };
        if let Some(error) = uncertain {
            if error.disposition != agent_desktop_core::DeliverySemantics::uncertain() {
                return Err(error);
            }
            let observed = crate::tree::copy_value_typed(element, deadline);
            let role = ax_helpers::element_role(element, deadline).ok().flatten();
            let verified = chain_verify::dynamic_write_had_effect(
                attribute,
                role.as_deref(),
                value,
                observed.as_deref(),
            );
            return if verified {
                Ok(DeliveryOutcome::DeliveredVerified)
            } else {
                Err(error)
            };
        }
        let mut delivery = crate::actions::DeliveryTracker::default();
        delivery.mark_delivered();
        prepare(element, deadline).map_err(|error| delivery.annotate(error))?;
        let role = ax_helpers::element_role(element, deadline)
            .map_err(|error| delivery.annotate(error))?;
        let observed = crate::tree::copy_value_typed(element, deadline);
        Ok(DeliveryOutcome::from_delivery(
            true,
            chain_verify::dynamic_write_had_effect(
                attribute,
                role.as_deref(),
                value,
                observed.as_deref(),
            ),
        ))
    }

    pub(crate) fn increment_to_value(
        element: &AXElement,
        target: &str,
        deadline: Deadline,
    ) -> Result<DeliveryOutcome, AdapterError> {
        const MAX_INCREMENT_STEPS: usize = 1_024;

        let requested = target;
        let Some(target) = finite_target(requested) else {
            return Ok(DeliveryOutcome::NotDelivered);
        };
        let Some((mut current, mut current_text)) = read_number(element, deadline)? else {
            return Ok(DeliveryOutcome::NotDelivered);
        };
        let start = current;
        let mut delivered = false;
        let mut delivery = crate::actions::DeliveryTracker::default();
        for _ in 0..MAX_INCREMENT_STEPS {
            if increment_target_reached(&current_text, requested) {
                return Ok(if delivered {
                    DeliveryOutcome::DeliveredVerified
                } else {
                    DeliveryOutcome::SatisfiedNoDelivery
                });
            }
            if deadline.is_expired() {
                return Err(delivery.annotate(chain_verify::increment_deadline_error(
                    start, current, target,
                )));
            }
            let Some(action) = increment_action(&current_text, requested) else {
                return Ok(DeliveryOutcome::from_delivery(delivered, false));
            };
            prepare(element, deadline).map_err(|error| delivery.annotate(error))?;
            let delivered_step = ax_helpers::try_ax_action_or_err(element, action, deadline)
                .map_err(|error| delivery.annotate(error))?;
            if !delivered_step {
                break;
            }
            delivered = true;
            delivery.mark_delivered();
            match read_number(element, deadline).map_err(|error| delivery.annotate(error))? {
                Some((next, text)) => {
                    let progressed = increment_progressed(&current_text, &text, requested);
                    current = next;
                    current_text = text;
                    if !progressed {
                        return Err(delivery.annotate(AdapterError::new(
                            agent_desktop_core::ErrorCode::ActionFailed,
                            "Native increments stopped progressing toward the requested value",
                        ).with_suggestion("Read the current value; choose a target supported by the control's native step size.")));
                    }
                }
                _ => break,
            }
        }
        if increment_target_reached(&current_text, requested) {
            return Ok(DeliveryOutcome::DeliveredVerified);
        }
        if (current - start).abs() >= f64::EPSILON {
            return Err(chain_verify::increment_step_limit_error(
                start, current, target,
            ));
        }
        Ok(DeliveryOutcome::from_delivery(delivered, false))
    }

    pub(crate) fn set_bool_verified(
        element: &AXElement,
        attribute: &str,
        value: bool,
        deadline: Deadline,
    ) -> Result<DeliveryOutcome, AdapterError> {
        prepare(element, deadline)?;
        let delivered = match ax_helpers::set_ax_bool_or_err(element, attribute, value, deadline) {
            Ok(delivered) => delivered,
            Err(error)
                if error.disposition == agent_desktop_core::DeliverySemantics::uncertain()
                    && focus_write_had_effect(element, attribute, value, deadline) =>
            {
                return Ok(DeliveryOutcome::DeliveredVerified);
            }
            Err(error) => return Err(error),
        };
        if !delivered {
            return Ok(DeliveryOutcome::NotDelivered);
        }
        let mut delivery = crate::actions::DeliveryTracker::default();
        delivery.mark_delivered();
        prepare(element, deadline).map_err(|error| delivery.annotate(error))?;
        let observed = crate::tree::copy_bool_attr(element, attribute, deadline);
        let verified = chain_verify::bool_write_had_effect(attribute, value, observed)
            || focus_write_had_effect(element, attribute, value, deadline);
        Ok(DeliveryOutcome::from_delivery(
            delivered,
            delivered && verified,
        ))
    }

    /// An element's own `AXFocused` stays false when it delegates editing to a
    /// child, so reading it back calls a focus that plainly landed a failure.
    /// The write itself answers `kAXErrorFailure` for the same reason, a code
    /// that proves nothing either way, so both paths settle by looking instead.
    fn focus_write_had_effect(
        element: &AXElement,
        attribute: &str,
        value: bool,
        deadline: Deadline,
    ) -> bool {
        if attribute != accessibility_sys::kAXFocusedAttribute || !value {
            return false;
        }
        crate::actions::activation_effect::focus_state(element, deadline)
            .and_then(|state| state.focused_element())
            .is_some_and(|focused| {
                crate::actions::activation_effect::focus_reached(&focused, element, deadline)
            })
    }

    pub(crate) fn increment_action(current: &str, target: &str) -> Option<&'static str> {
        let ordering =
            if let (Ok(current), Ok(target)) = (current.parse::<i128>(), target.parse::<i128>()) {
                current.cmp(&target)
            } else {
                let (current, target) = (finite_target(current)?, finite_target(target)?);
                if current.abs().max(target.abs()) >= 9_007_199_254_740_992.0 {
                    return None;
                }
                current.partial_cmp(&target)?
            };
        match ordering {
            std::cmp::Ordering::Less => Some("AXIncrement"),
            std::cmp::Ordering::Greater => Some("AXDecrement"),
            std::cmp::Ordering::Equal => None,
        }
    }

    pub(crate) fn increment_progressed(before: &str, after: &str, target: &str) -> bool {
        let direction = increment_action(before, target);
        increment_target_reached(after, target)
            || (direction.is_some()
                && increment_action(before, after) == direction
                && increment_action(after, target) == direction)
    }

    pub(crate) fn increment_target_reached(current: &str, target: &str) -> bool {
        agent_desktop_core::value_matches("incrementor", target, Some(current))
    }

    pub(crate) fn finite_target(target: &str) -> Option<f64> {
        target.parse::<f64>().ok().filter(|value| value.is_finite())
    }

    fn read_number(
        element: &AXElement,
        deadline: Deadline,
    ) -> Result<Option<(f64, String)>, AdapterError> {
        prepare(element, deadline)?;
        Ok(crate::tree::copy_value_typed(element, deadline)
            .and_then(|value| finite_target(&value).map(|number| (number, value))))
    }

    fn prepare(element: &AXElement, deadline: Deadline) -> Result<(), AdapterError> {
        crate::tree::properties::attributes::set_messaging_timeout(element, deadline)
    }
}

#[cfg(target_os = "macos")]
pub(crate) use imp::{increment_to_value, set_bool_verified, set_dynamic_verified};

#[cfg(all(test, target_os = "macos"))]
use imp::{finite_target, increment_action, increment_target_reached};

#[cfg(test)]
#[path = "chain_value_write_tests.rs"]
mod tests;
