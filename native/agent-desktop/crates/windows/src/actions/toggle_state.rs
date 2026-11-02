//! Toggle / Check / Uncheck via TogglePattern with Invoke fallback (A19-2).

use agent_desktop_core::{ActionStep, AdapterError, Deadline, ErrorCode, InteractionPolicy};
use std::time::{Duration, Instant};

use crate::actions::chain::{
    ALREADY_LABEL, ChainDef, ChainRung, DeliveryOutcome, INVOKE_LABEL, build_step,
    capped_verification_end, execute_chain,
};
use crate::tree::element::UIAElement;

pub(crate) const TOGGLE_LABEL: &str = "TogglePattern.Toggle";

const TOGGLE_TIMEOUT: Duration = Duration::from_millis(600);
const TOGGLE_STABLE: Duration = Duration::from_millis(200);
const POLL_SLICE: Duration = Duration::from_millis(25);

pub(crate) const TOGGLE_CHAIN: ChainDef = ChainDef {
    suggestion: "Refresh the snapshot and retry, or target an element that advertises Toggle or Invoke.",
    continue_after_unverified_delivery: false,
};

const CHECK_SUGGESTION: &str =
    "Refresh the snapshot and inspect the checked state before deciding whether to retry.";

/// UIA `ToggleState` values (A15-7 / A19-2).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ToggleKind {
    Off,
    On,
    Indeterminate,
}

impl ToggleKind {
    pub(crate) fn from_i32(value: i32) -> Option<Self> {
        match value {
            0 => Some(Self::Off),
            1 => Some(Self::On),
            2 => Some(Self::Indeterminate),
            _ => None,
        }
    }

    fn matches_checked(self, want_checked: bool) -> bool {
        matches!((self, want_checked), (Self::On, true) | (Self::Off, false))
    }
}

/// Availability flags for the Toggle chain's two rungs, bundled so
/// `toggle_judged_for` stays within the 5-parameter cap.
pub(crate) struct ToggleAvailability {
    pub(crate) toggle_ok: bool,
    pub(crate) invoke_ok: bool,
}

/// Injected Check/Uncheck plan: target state plus rung availability,
/// bundled so `check_uncheck_judged_for` stays within the 5-parameter cap.
pub(crate) struct CheckUncheckPlan {
    pub(crate) want_checked: bool,
    pub(crate) toggle_ok: bool,
    pub(crate) invoke_ok: bool,
}

#[cfg(target_os = "windows")]
mod imp {
    use super::{
        ALREADY_LABEL, ActionStep, AdapterError, CHECK_SUGGESTION, ChainRung, CheckUncheckPlan,
        Deadline, DeliveryOutcome, ErrorCode, INVOKE_LABEL, Instant, InteractionPolicy, POLL_SLICE,
        TOGGLE_CHAIN, TOGGLE_LABEL, TOGGLE_STABLE, TOGGLE_TIMEOUT, ToggleAvailability, ToggleKind,
        UIAElement, build_step, capped_verification_end, execute_chain,
    };
    use crate::actions::chain::{
        after_delivery, delivery_occurred, gated, invoke_available, invoke_pattern_delivered,
    };
    use crate::actions::mutation::{classify_success, classify_write};
    use crate::tree::properties::property_ids::TreeProperty;
    use crate::tree::properties::read_one;
    use uiautomation::patterns::UITogglePattern;

    pub(crate) fn toggle_steps(
        element: &UIAElement,
        policy: InteractionPolicy,
        deadline: Deadline,
    ) -> Result<Vec<ActionStep>, AdapterError> {
        let toggle_ok = toggle_available(element);
        let before = if toggle_ok {
            read_toggle_state(element)
        } else {
            None
        };
        let invoke_ok = invoke_available(element);
        toggle_judged_for(
            deadline,
            policy,
            ToggleAvailability {
                toggle_ok,
                invoke_ok,
            },
            || delivered_with_observe(before, deadline, element, pattern_toggle),
            || delivered_with_observe(before, deadline, element, invoke_pattern_delivered),
        )
    }

    pub(crate) fn check_steps(
        element: &UIAElement,
        _policy: InteractionPolicy,
        deadline: Deadline,
    ) -> Result<Vec<ActionStep>, AdapterError> {
        check_uncheck_steps(element, true, deadline)
    }

    pub(crate) fn uncheck_steps(
        element: &UIAElement,
        _policy: InteractionPolicy,
        deadline: Deadline,
    ) -> Result<Vec<ActionStep>, AdapterError> {
        check_uncheck_steps(element, false, deadline)
    }

    fn check_uncheck_steps(
        element: &UIAElement,
        want_checked: bool,
        deadline: Deadline,
    ) -> Result<Vec<ActionStep>, AdapterError> {
        check_uncheck_judged_for(
            deadline,
            CheckUncheckPlan {
                want_checked,
                toggle_ok: toggle_available(element),
                invoke_ok: invoke_available(element),
            },
            || read_toggle_kind(element),
            || pattern_toggle(element),
            || invoke_pattern_delivered(element),
        )
    }

    /// Injected Toggle chain — unit-test seam and live path.
    pub(crate) fn toggle_judged_for(
        deadline: Deadline,
        policy: InteractionPolicy,
        availability: ToggleAvailability,
        mut toggle: impl FnMut() -> Result<DeliveryOutcome, AdapterError>,
        mut invoke: impl FnMut() -> Result<DeliveryOutcome, AdapterError>,
    ) -> Result<Vec<ActionStep>, AdapterError> {
        let mut toggle_run = gated(availability.toggle_ok, &mut toggle);
        let mut invoke_run = gated(availability.invoke_ok, &mut invoke);
        execute_chain(
            deadline,
            &TOGGLE_CHAIN,
            policy,
            &mut [
                ChainRung {
                    label: TOGGLE_LABEL,
                    requires_headed: false,
                    run: &mut toggle_run,
                },
                ChainRung {
                    label: INVOKE_LABEL,
                    requires_headed: false,
                    run: &mut invoke_run,
                },
            ],
        )
    }

    /// Injected Check/Uncheck — unit-test seam and live path.
    pub(crate) fn check_uncheck_judged_for(
        deadline: Deadline,
        plan: CheckUncheckPlan,
        mut read_state: impl FnMut() -> Option<ToggleKind>,
        mut toggle: impl FnMut() -> Result<bool, AdapterError>,
        mut invoke: impl FnMut() -> Result<bool, AdapterError>,
    ) -> Result<Vec<ActionStep>, AdapterError> {
        let want_checked = plan.want_checked;
        deadline.ensure_remaining()?;
        let before = read_state();
        if before.is_some_and(|state| state.matches_checked(want_checked)) {
            return Ok(vec![build_step(
                ALREADY_LABEL,
                DeliveryOutcome::SatisfiedNoDelivery,
            )]);
        }
        let mut steps = Vec::new();
        if plan.toggle_ok {
            for attempt in 0..2 {
                deadline.ensure_remaining()?;
                if !toggle()? {
                    break;
                }
                let last = attempt == 1;
                let verified = poll_checked(
                    want_checked,
                    deadline,
                    &mut read_state,
                    if last { None } else { before },
                )
                .map_err(after_delivery)?;
                steps.push(build_step(
                    TOGGLE_LABEL,
                    DeliveryOutcome::from_delivery(true, verified),
                ));
                if verified || !observed_a_change(before, read_state()) {
                    return Ok(steps);
                }
            }
        }
        if plan.invoke_ok && !delivery_occurred(&steps) {
            deadline.ensure_remaining()?;
            if invoke()? {
                let verified = poll_checked(want_checked, deadline, &mut read_state, None)
                    .map_err(after_delivery)?;
                steps.push(build_step(
                    INVOKE_LABEL,
                    DeliveryOutcome::from_delivery(true, verified),
                ));
                return Ok(steps);
            }
            steps.push(build_step(INVOKE_LABEL, DeliveryOutcome::NotDelivered));
        }
        if delivery_occurred(&steps) {
            return Ok(steps);
        }
        Err(exhausted())
    }

    fn delivered_with_observe(
        before: Option<ToggleKind>,
        deadline: Deadline,
        element: &UIAElement,
        deliver: impl FnOnce(&UIAElement) -> Result<bool, AdapterError>,
    ) -> Result<DeliveryOutcome, AdapterError> {
        if !deliver(element)? {
            return Ok(DeliveryOutcome::NotDelivered);
        }
        Ok(DeliveryOutcome::from_delivery(
            true,
            observe_change(before, deadline, element).map_err(after_delivery)?,
        ))
    }

    fn toggle_available(element: &UIAElement) -> bool {
        read_one(element, TreeProperty::ToggleAvailable).flag() == Some(true)
    }

    fn read_toggle_state(element: &UIAElement) -> Option<ToggleKind> {
        read_one(element, TreeProperty::ToggleState)
            .number()
            .and_then(ToggleKind::from_i32)
    }

    fn read_toggle_kind(element: &UIAElement) -> Option<ToggleKind> {
        if !toggle_available(element) {
            return None;
        }
        read_toggle_state(element)
    }

    fn pattern_toggle(element: &UIAElement) -> Result<bool, AdapterError> {
        match element.0.get_pattern::<UITogglePattern>() {
            Ok(pattern) => match pattern.toggle() {
                Ok(()) => classify_success(),
                Err(error) => classify_write("Toggle", TOGGLE_LABEL, &error),
            },
            Err(error) => classify_write("get_pattern", TOGGLE_LABEL, &error),
        }
    }

    /// `before` is only ever `Some` when the caller's own upfront
    /// `toggle_available` read was true (`toggle_steps`), so this loop reads
    /// `ToggleState` directly rather than re-issuing that availability
    /// check on every tick the way `read_toggle_kind` would.
    fn observe_change(
        before: Option<ToggleKind>,
        deadline: Deadline,
        element: &UIAElement,
    ) -> Result<bool, AdapterError> {
        let Some(before) = before else {
            return Ok(false);
        };
        let end = capped_verification_end(deadline, TOGGLE_TIMEOUT)?;
        let mut candidate: Option<(ToggleKind, Instant)> = None;
        loop {
            if let Some(current) = read_toggle_state(element) {
                if current != before {
                    match &mut candidate {
                        Some((value, since)) if *value == current => {
                            if since.elapsed() >= TOGGLE_STABLE {
                                return Ok(true);
                            }
                        }
                        _ => candidate = Some((current, Instant::now())),
                    }
                } else {
                    candidate = None;
                }
            }
            if Instant::now() >= end {
                return Ok(false);
            }
            sleep_poll(deadline)?;
        }
    }

    /// Whether the control demonstrably moved, which is what licenses a
    /// second toggle.
    ///
    /// A tri-state control needs two toggles to reach checked from
    /// indeterminate, and after the first one the state has visibly changed -
    /// the delivery is proven, and the second toggle continues toward the
    /// target. A state that reads the same as it did before is the opposite
    /// case: either the toggle did not land, or it landed and this provider
    /// is not reporting it. Toggling again on that ambiguity is the one move
    /// that can end with the control back where it started while the step
    /// reports delivery, so the unverified delivery is returned instead and
    /// the caller re-reads.
    fn observed_a_change(before: Option<ToggleKind>, after: Option<ToggleKind>) -> bool {
        before.is_some() && after.is_some() && before != after
    }

    fn poll_checked(
        want_checked: bool,
        deadline: Deadline,
        read_state: &mut impl FnMut() -> Option<ToggleKind>,
        early_exit_after_change_from: Option<ToggleKind>,
    ) -> Result<bool, AdapterError> {
        let end = capped_verification_end(deadline, TOGGLE_TIMEOUT)?;
        loop {
            match read_state() {
                Some(state) if state.matches_checked(want_checked) => return Ok(true),
                Some(state)
                    if early_exit_after_change_from.is_some_and(|before| state != before) =>
                {
                    sleep_poll(deadline)?;
                    return Ok(
                        read_state().is_some_and(|state| state.matches_checked(want_checked))
                    );
                }
                _ => {}
            }
            if Instant::now() >= end {
                return Ok(false);
            }
            sleep_poll(deadline)?;
        }
    }

    fn sleep_poll(deadline: Deadline) -> Result<(), AdapterError> {
        std::thread::sleep(deadline.remaining_slice(POLL_SLICE)?);
        Ok(())
    }

    fn exhausted() -> AdapterError {
        AdapterError::new(ErrorCode::ActionFailed, "All chain steps exhausted")
            .with_disposition(agent_desktop_core::DeliverySemantics::not_delivered())
            .with_suggestion(CHECK_SUGGESTION)
    }
}

#[cfg(not(target_os = "windows"))]
mod imp {
    use super::{ActionStep, AdapterError, Deadline, InteractionPolicy, UIAElement};

    pub(crate) fn toggle_steps(
        _: &UIAElement,
        _: InteractionPolicy,
        _: Deadline,
    ) -> Result<Vec<ActionStep>, AdapterError> {
        Err(AdapterError::not_supported("Toggle"))
    }
    pub(crate) fn check_steps(
        _: &UIAElement,
        _: InteractionPolicy,
        _: Deadline,
    ) -> Result<Vec<ActionStep>, AdapterError> {
        Err(AdapterError::not_supported("Check"))
    }
    pub(crate) fn uncheck_steps(
        _: &UIAElement,
        _: InteractionPolicy,
        _: Deadline,
    ) -> Result<Vec<ActionStep>, AdapterError> {
        Err(AdapterError::not_supported("Uncheck"))
    }
}

pub(crate) use imp::{check_steps, toggle_steps, uncheck_steps};

#[cfg(all(test, target_os = "windows"))]
pub(crate) use imp::{check_uncheck_judged_for, toggle_judged_for};

#[cfg(all(test, target_os = "windows"))]
#[path = "toggle_state_tests.rs"]
mod tests;
