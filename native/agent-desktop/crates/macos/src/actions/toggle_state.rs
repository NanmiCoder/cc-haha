use agent_desktop_core::{
    ActionStep, AdapterError, Deadline, DeliverySemantics, ErrorCode, InteractionPolicy,
    StepMechanism,
};

use crate::{
    actions::{
        ax_helpers,
        chain::chain_defs,
        chain::{ChainContext, execute_chain},
    },
    tree::{AXElement, state_reader::parse_checked_value},
};

const TOGGLE_TIMEOUT: std::time::Duration = std::time::Duration::from_millis(600);
const TOGGLE_STABLE: std::time::Duration = std::time::Duration::from_millis(200);

pub(crate) fn toggle(
    el: &AXElement,
    policy: InteractionPolicy,
    deadline: Deadline,
) -> Result<Vec<ActionStep>, AdapterError> {
    let role = read_role(el, deadline)?;
    if !role
        .as_deref()
        .is_some_and(crate::tree::roles::is_toggleable_role)
    {
        return Err(AdapterError::new(
            ErrorCode::ActionNotSupported,
            format!(
                "Toggle not supported on role '{}'",
                role.as_deref().unwrap_or("unknown")
            ),
        )
        .with_suggestion(
            "Toggle works on checkboxes, switches, and radio buttons. Use 'click' for other elements.",
        ));
    }
    let before = read_value(el, deadline)?;
    let mut steps = semantic_click(el, policy, deadline)?;
    let verified = if let Some(before) = before {
        wait_for_value_change(el, &before, deadline).map_err(after_delivery)?;
        true
    } else {
        false
    };
    mark_last_verified(&mut steps, verified);
    Ok(steps)
}

pub(crate) fn check_uncheck(
    el: &AXElement,
    want_checked: bool,
    policy: InteractionPolicy,
    deadline: Deadline,
) -> Result<Vec<ActionStep>, AdapterError> {
    let role = read_role(el, deadline)?;
    if !role
        .as_deref()
        .is_some_and(crate::tree::roles::is_toggleable_role)
    {
        return Err(AdapterError::new(
            ErrorCode::ActionNotSupported,
            format!(
                "check/uncheck not supported on role '{}'",
                role.as_deref().unwrap_or("unknown")
            ),
        )
        .with_suggestion("Only works on checkboxes, switches, and radio buttons."));
    }
    let press_after_ignored_write = want_checked
        || agent_desktop_core::Role::from_token(role.as_deref().unwrap_or_default())
            != agent_desktop_core::Role::RadioButton;
    run_check(
        &mut LiveToggleTarget {
            el,
            policy,
            deadline,
        },
        want_checked,
        press_after_ignored_write,
    )
}

fn semantic_click(
    el: &AXElement,
    policy: InteractionPolicy,
    deadline: Deadline,
) -> Result<Vec<ActionStep>, AdapterError> {
    let ctx = ChainContext {
        dynamic_value: None,
        verified_point: None,
        deadline,
    };
    execute_chain(el, &chain_defs::SEMANTIC_CLICK_CHAIN, &ctx, policy)
}

trait CheckTarget {
    fn checked(&mut self) -> Result<Option<bool>, AdapterError>;
    fn value_settable(&mut self) -> Result<bool, AdapterError>;
    fn write_value(&mut self, want_checked: bool) -> Result<bool, AdapterError>;
    fn settle(&mut self, want_checked: bool) -> Result<Option<bool>, AdapterError>;
    fn click(&mut self) -> Result<Vec<ActionStep>, AdapterError>;
}

struct LiveToggleTarget<'a> {
    el: &'a AXElement,
    policy: InteractionPolicy,
    deadline: Deadline,
}

impl CheckTarget for LiveToggleTarget<'_> {
    fn checked(&mut self) -> Result<Option<bool>, AdapterError> {
        checked_state(self.el, self.deadline)
    }

    fn value_settable(&mut self) -> Result<bool, AdapterError> {
        prepare(self.el, self.deadline)?;
        ax_helpers::is_attr_settable(self.el, "AXValue", self.deadline)
    }

    fn write_value(&mut self, want_checked: bool) -> Result<bool, AdapterError> {
        prepare(self.el, self.deadline)?;
        ax_helpers::set_ax_bool_or_err(self.el, "AXValue", want_checked, self.deadline)
    }

    fn settle(&mut self, want_checked: bool) -> Result<Option<bool>, AdapterError> {
        settle_checked_state(self.el, want_checked, self.deadline)
    }

    fn click(&mut self) -> Result<Vec<ActionStep>, AdapterError> {
        semantic_click(self.el, self.policy, self.deadline)
    }
}

#[path = "toggle_state_radio.rs"]
mod radio;

fn run_check(
    target: &mut impl CheckTarget,
    want_checked: bool,
    press_after_ignored_write: bool,
) -> Result<Vec<ActionStep>, AdapterError> {
    if target.checked()? == Some(want_checked) {
        return Ok(vec![already_in_state_step()]);
    }
    let mut steps = Vec::new();
    let mut wrote = false;
    if target.value_settable()? {
        if target.write_value(want_checked)? {
            wrote = true;
        } else {
            steps.push(ignored_write_step());
        }
    }
    if wrote {
        if target.settle(want_checked).map_err(after_delivery)? == Some(want_checked) {
            return Ok(vec![value_write_step()]);
        }
        match target.checked().map_err(after_delivery)? {
            Some(state) if state == want_checked => return Ok(vec![value_write_step()]),
            Some(_) if press_after_ignored_write => steps.push(ignored_write_step()),
            Some(_) => return Err(after_delivery(radio::uncheck_unsupported())),
            None => return Err(after_delivery(state_not_reached())),
        }
    }
    if !wrote && !press_after_ignored_write {
        return radio::refuse_uncheck(target, want_checked, !steps.is_empty());
    }
    let clicked = target
        .click()
        .map_err(|error| if wrote { after_delivery(error) } else { error })?;
    steps.extend(clicked);
    if target.settle(want_checked).map_err(after_delivery)? != Some(want_checked) {
        return Err(after_delivery(state_not_reached()));
    }
    mark_last_verified(&mut steps, true);
    Ok(steps)
}

fn ignored_write_step() -> ActionStep {
    ActionStep::attempted("AXValue").with_mechanism(StepMechanism::SemanticApi)
}

fn value_write_step() -> ActionStep {
    ActionStep::succeeded("AXValue")
        .with_mechanism(StepMechanism::SemanticApi)
        .with_verified(true)
}

fn state_not_reached() -> AdapterError {
    AdapterError::new(
        ErrorCode::ActionFailed,
        "check/uncheck did not reach the requested state",
    )
    .with_details(serde_json::json!({
        "verification": "requested_checked_state_not_observed"
    }))
    .with_suggestion(
        "Refresh the snapshot and inspect the checked state before deciding whether to retry.",
    )
}

fn already_in_state_step() -> ActionStep {
    ActionStep::skipped("AlreadyInState").with_verified(true)
}

fn after_delivery(error: AdapterError) -> AdapterError {
    error.with_disposition(DeliverySemantics::delivered_unverified())
}

fn mark_last_verified(steps: &mut [ActionStep], verified: bool) {
    if let Some(step) = steps.last_mut() {
        step.verified = Some(verified);
    }
}

fn checked_state(el: &AXElement, deadline: Deadline) -> Result<Option<bool>, AdapterError> {
    Ok(read_value(el, deadline)?.and_then(|value| parse_checked_value(&value)))
}

fn settle_checked_state(
    el: &AXElement,
    want_checked: bool,
    action_deadline: Deadline,
) -> Result<Option<bool>, AdapterError> {
    let deadline = verification_deadline(action_deadline)?;
    loop {
        let state = checked_state(el, action_deadline)?;
        if state == Some(want_checked) || std::time::Instant::now() >= deadline {
            return Ok(state);
        }
        sleep_poll(deadline, action_deadline)?;
    }
}

fn wait_for_value_change(
    el: &AXElement,
    before: &str,
    action_deadline: Deadline,
) -> Result<(), AdapterError> {
    let deadline = verification_deadline(action_deadline)?;
    let mut candidate: Option<(String, std::time::Instant)> = None;
    loop {
        if let Some(changed) = read_value(el, action_deadline)? {
            if changed != before {
                match &mut candidate {
                    Some((candidate_value, since)) if candidate_value == &changed => {
                        if since.elapsed() >= TOGGLE_STABLE {
                            return Ok(());
                        }
                    }
                    _ => {
                        candidate = Some((changed, std::time::Instant::now()));
                    }
                }
            } else {
                candidate = None;
            }
        }
        if std::time::Instant::now() >= deadline {
            return Err(AdapterError::new(
                ErrorCode::ActionFailed,
                "toggle did not change the element value",
            )
            .with_details(serde_json::json!({
                "verification": "stable_value_change_not_observed"
            }))
            .with_suggestion(
                "Refresh the snapshot and inspect the value before deciding whether to retry or use 'click'.",
            ));
        }
        sleep_poll(deadline, action_deadline)?;
    }
}

fn verification_deadline(action_deadline: Deadline) -> Result<std::time::Instant, AdapterError> {
    let local = std::time::Instant::now() + TOGGLE_TIMEOUT;
    let remaining = action_deadline.remaining();
    if remaining.is_zero() {
        Err(action_deadline.timeout_error())
    } else {
        Ok(std::time::Instant::now()
            .checked_add(remaining)
            .map_or(local, |deadline| deadline.min(local)))
    }
}

fn sleep_poll(deadline: std::time::Instant, action_deadline: Deadline) -> Result<(), AdapterError> {
    let remaining = deadline.saturating_duration_since(std::time::Instant::now());
    if !remaining.is_zero() {
        std::thread::sleep(remaining.min(std::time::Duration::from_millis(25)));
    }
    if action_deadline.is_expired() {
        Err(action_deadline
            .timeout_error()
            .with_details(serde_json::json!({
                "verification": "action_deadline_elapsed",
            })))
    } else {
        Ok(())
    }
}

fn read_value(el: &AXElement, deadline: Deadline) -> Result<Option<String>, AdapterError> {
    use accessibility_sys::{
        kAXErrorAPIDisabled, kAXErrorCannotComplete, kAXErrorInvalidUIElement,
    };

    crate::tree::properties::attributes::set_messaging_timeout(el, deadline)?;
    let result = crate::tree::properties::attributes::copy_value_typed_result(el, deadline);
    if deadline.is_expired() {
        return Err(deadline.timeout_error());
    }
    result.map_err(|error| {
        let code = if error == kAXErrorAPIDisabled {
            ErrorCode::PermDenied
        } else if error == kAXErrorCannotComplete {
            ErrorCode::Timeout
        } else if error == kAXErrorInvalidUIElement {
            ErrorCode::StaleRef
        } else {
            ErrorCode::ActionFailed
        };
        AdapterError::new(code, "Could not verify the live toggle value")
            .with_details(serde_json::json!({ "ax_error": error }))
    })
}

fn read_role(el: &AXElement, deadline: Deadline) -> Result<Option<String>, AdapterError> {
    ax_helpers::element_role(el, deadline)
}

fn prepare(el: &AXElement, deadline: Deadline) -> Result<(), AdapterError> {
    crate::tree::properties::attributes::set_messaging_timeout(el, deadline)
}

#[cfg(test)]
mod tests {
    use agent_desktop_core::actions::action_step::ActionStep;

    use super::{already_in_state_step, mark_last_verified, parse_checked_value};

    #[test]
    fn parses_checked_values_from_common_ax_strings() {
        for value in ["1", "true", "TRUE", "YES", "on", "checked"] {
            assert_eq!(parse_checked_value(value), Some(true));
        }
        for value in ["0", "false", "FALSE", "NO", "off", "unchecked"] {
            assert_eq!(parse_checked_value(value), Some(false));
        }
    }

    #[test]
    fn treats_mixed_and_unknown_checked_values_as_indeterminate() {
        for value in ["2", "mixed", "indeterminate", "maybe", ""] {
            assert_eq!(parse_checked_value(value), None);
        }
    }

    #[test]
    fn absent_toggle_state_does_not_inherit_click_verification() {
        let mut steps = vec![ActionStep::succeeded("verified_press").with_verified(true)];
        mark_last_verified(&mut steps, false);
        assert_eq!(steps[0].verified(), Some(false));
    }

    #[test]
    fn toggle_state_verification_upgrades_an_unverified_step() {
        let mut steps = vec![ActionStep::succeeded("AXPress").with_verified(false)];
        mark_last_verified(&mut steps, true);
        assert_eq!(steps[0].verified(), Some(true));
    }

    #[test]
    fn already_in_state_is_verified_without_claiming_delivery() {
        let step = already_in_state_step();
        assert!(matches!(
            step.outcome,
            agent_desktop_core::actions::action_step_outcome::ActionStepOutcome::Skipped
        ));
        assert!(step.mechanism().is_none());
        assert_eq!(step.verified(), Some(true));
    }
}

#[cfg(test)]
#[path = "toggle_state_check_tests.rs"]
mod check_tests;
