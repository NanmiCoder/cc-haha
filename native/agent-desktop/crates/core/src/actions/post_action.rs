use crate::{
    Action, ActionRequest, ActionResult, AdapterError, DeliverySemantics, ErrorCode,
    InteractionLease, LiveElement, NativeHandle, PlatformAdapter,
};

/// Executes once, then verifies stateful actions from fresh platform observations.
pub fn execute_verified_action(
    adapter: &dyn PlatformAdapter,
    handle: &NativeHandle,
    mut request: ActionRequest,
    lease: &InteractionLease,
) -> Result<ActionResult, AdapterError> {
    let action = request.action.clone();
    if !action.requires_state_readback() {
        return adapter.execute_action(handle, request, lease);
    }
    let deadline = lease.deadline();
    let before = matches!(action, Action::TypeText(_) | Action::Toggle)
        .then(|| adapter.get_live_element(handle, deadline).ok())
        .flatten();
    if matches!(action, Action::Toggle)
        && let Some(checked) = before.as_ref().and_then(checked)
    {
        request.action = if checked {
            Action::Uncheck
        } else {
            Action::Check
        };
    }
    let expected_text = match (&action, &before) {
        (Action::TypeText(text), Some(before)) => before.state.value.as_deref().and_then(|value| {
            let selection_is_preserved = !request.policy.is_headed()
                || crate::tree::state::has_state(&before.state.states, crate::tree::state::FOCUSED);
            let selection = selection_is_preserved
                .then(|| adapter.get_text_selection(handle, deadline).ok().flatten())
                .flatten();
            expected_insertion(value, text, selection)
        }),
        _ => None,
    };
    let execution = adapter
        .execute_action(handle, request, lease)
        .map(|mut result| {
            if matches!(action, Action::Toggle) {
                result.action = action.name().into();
            }
            result
        });
    if execution
        .as_ref()
        .is_err_and(|error| error.disposition == DeliverySemantics::not_delivered())
    {
        return execution;
    }
    let mut observed = adapter.get_live_element(handle, deadline);
    let settle = std::time::Duration::from_millis(50);
    let settle_deadline = deadline.capped(std::time::Duration::from_millis(400));
    let drains = execution
        .as_ref()
        .is_ok_and(|result| typed_by_keys(&action, result));
    let mut changing = true;
    while execution.is_ok()
        && observed.as_ref().is_ok_and(|observed| {
            matches_postcondition(&action, before.as_ref(), expected_text.as_deref(), observed)
                == Some(false)
        })
        && (settle_deadline.remaining() > settle
            || (drains && changing && deadline.remaining() > settle))
    {
        crate::wait::deadline::sleep(settle);
        let next = adapter.get_live_element(handle, deadline);
        changing = value_of(&next) != value_of(&observed);
        observed = next;
    }
    let mut result = match execution {
        Ok(result) => result,
        Err(mut error) => {
            if let Ok(observed) = observed {
                let details = error.details.get_or_insert_with(|| serde_json::json!({}));
                if let Some(details) = details.as_object_mut() {
                    details.insert("post_state".into(), serde_json::json!(observed.state));
                    if let Some(satisfied) = matches_postcondition(
                        &action,
                        before.as_ref(),
                        expected_text.as_deref(),
                        &observed,
                    ) {
                        details.insert("postcondition_satisfied".into(), satisfied.into());
                    }
                }
            }
            return Err(error);
        }
    };
    let observed = observed.map_err(|error| verification_error(&result, None, error))?;
    let verified = matches_postcondition(
        &action,
        before.as_ref(),
        expected_text.as_deref(),
        &observed,
    );
    let physical_text_mismatch = verified == Some(false) && typed_by_keys(&action, &result);
    if verified.is_none() || physical_text_mismatch {
        let reason = if physical_text_mismatch {
            "postcondition_mismatch"
        } else if secure_value_is_redacted(&action, &observed) {
            "secure_field"
        } else {
            "insufficient_evidence"
        };
        result.post_state = Some(observed.state);
        result = result.with_unverified_delivery();
        let details = result.details.get_or_insert_with(|| serde_json::json!({}));
        if let Some(details) = details.as_object_mut() {
            details.insert("verification_scope".into(), "unavailable".into());
            details.insert("verification_reason".into(), reason.into());
            details.insert("application_commit".into(), "not_verified".into());
        }
        return Ok(result);
    }
    if verified == Some(false) {
        return Err(verification_error(
            &result,
            Some(&observed),
            mismatch_error(&action),
        ));
    }
    result.post_state = Some(observed.state);
    result = result.with_verified_delivery();
    let details = result.details.get_or_insert_with(|| serde_json::json!({}));
    if let Some(details) = details.as_object_mut() {
        details.insert("verification_scope".into(), "element_state".into());
        if action.writes_element_value() {
            details.insert("verification_scope".into(), "element_value".into());
            details.insert("application_commit".into(), "not_verified".into());
        }
    }
    Ok(result)
}

/// Keys sent to a field reach it through the application's event queue, so
/// the field may still be filling after the last key left.
fn typed_by_keys(action: &Action, result: &ActionResult) -> bool {
    matches!(action, Action::TypeText(_))
        && result.steps.iter().any(|step| {
            matches!(&step.outcome, crate::ActionStepOutcome::Succeeded)
                && step.mechanism() == Some(crate::StepMechanism::PhysicalSynthetic)
        })
}

fn value_of(read: &Result<LiveElement, AdapterError>) -> Option<&str> {
    read.as_ref()
        .ok()
        .and_then(|observed| observed.state.value.as_deref())
}

fn mismatch_error(action: &Action) -> AdapterError {
    let error = AdapterError::new(
        ErrorCode::ActionFailed,
        "Post-action state does not match the requested change",
    );
    if matches!(action, Action::TypeText(_)) {
        return error.with_suggestion(
            "Some fields, often in Chromium and Electron apps, accept typed text without applying it. \
             Read the field with 'get', then write the full intended value with 'set-value'.",
        );
    }
    error
}

fn secure_value_is_redacted(action: &Action, observed: &LiveElement) -> bool {
    action.writes_element_value()
        && observed.state.value.is_none()
        && crate::tree::state::has_state(&observed.state.states, crate::tree::state::SECURE)
}

fn matches_postcondition(
    action: &Action,
    before: Option<&LiveElement>,
    expected_text: Option<&str>,
    observed: &LiveElement,
) -> Option<bool> {
    let state = &observed.state;
    match action {
        Action::SetValue(expected) => state
            .value
            .as_deref()
            .map(|value| crate::value_matches(&state.role, expected, Some(value))),
        Action::Clear => state.value.as_deref().map(str::is_empty),
        Action::TypeText(_) => expected_text
            .zip(state.value.as_deref())
            .map(|(expected, value)| expected == value),
        Action::Check | Action::Uncheck => {
            checked(observed).map(|value| value == matches!(action, Action::Check))
        }
        Action::Toggle => before
            .and_then(checked)
            .zip(checked(observed))
            .map(|(before, after)| before != after),
        Action::Expand | Action::Collapse => observed.states_complete.then(|| {
            crate::tree::state::has_state(&state.states, crate::tree::state::EXPANDED)
                == matches!(action, Action::Expand)
        }),
        _ => None,
    }
}

fn checked(element: &LiveElement) -> Option<bool> {
    if !element.states_complete
        || crate::tree::state::has_state(&element.state.states, crate::tree::state::INDETERMINATE)
    {
        return None;
    }
    Some(crate::tree::state::has_state(
        &element.state.states,
        crate::tree::state::CHECKED,
    ))
}

fn expected_insertion(
    before: &str,
    text: &str,
    selection: Option<std::ops::Range<usize>>,
) -> Option<String> {
    let range = selection.or_else(|| before.is_empty().then_some(0..0))?;
    let mut value: Vec<u16> = before.encode_utf16().collect();
    value.get(range.clone())?;
    String::from_utf16(&value[..range.start]).ok()?;
    String::from_utf16(&value[range.end..]).ok()?;
    value.splice(range, text.encode_utf16());
    String::from_utf16(&value).ok()
}

fn verification_error(
    result: &ActionResult,
    observed: Option<&LiveElement>,
    mut error: AdapterError,
) -> AdapterError {
    let disposition = if result.disposition() == DeliverySemantics::not_delivered() {
        DeliverySemantics::not_delivered()
    } else {
        DeliverySemantics::delivered_unverified()
    };
    let mut details = match error.details.take() {
        Some(serde_json::Value::Object(details)) => details,
        Some(cause) => serde_json::Map::from_iter([("cause".into(), cause)]),
        None => serde_json::Map::new(),
    };
    details.insert("kind".into(), "post_action_verification".into());
    details.insert("after_action".into(), serde_json::json!(result));
    if let Some(observed) = observed {
        details.insert("post_state".into(), serde_json::json!(observed.state));
    }
    if error.suggestion.is_none() {
        error.suggestion = Some(
            "Inspect the returned state before deciding whether another action is needed.".into(),
        );
    }
    error
        .with_disposition(disposition)
        .with_details(details.into())
}

#[cfg(test)]
#[path = "post_action_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "post_action_toggle_tests.rs"]
mod toggle_tests;
