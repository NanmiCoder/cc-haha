use crate::{
    AdapterError, AppError, ErrorCode,
    actions::action::Action,
    actions::action_request::ActionRequest,
    adapter::{NativeHandle, PlatformAdapter, optional_live_read},
    refs::RefEntry,
};
use serde_json::{Value, json};

#[derive(Debug)]
pub(crate) enum ElementPredicate {
    Exists,
    Enabled,
    Visible,
    Actionable(ActionRequest),
    Value(String),
}

impl ElementPredicate {
    pub(crate) fn parse(
        predicate: Option<&str>,
        value: Option<String>,
        action: Option<&str>,
    ) -> Result<Self, AppError> {
        match predicate.unwrap_or("exists") {
            "exists" => {
                reject_unused_value(value)?;
                reject_unused_action(action)?;
                Ok(Self::Exists)
            }
            "enabled" => {
                reject_unused_value(value)?;
                reject_unused_action(action)?;
                Ok(Self::Enabled)
            }
            "visible" => {
                reject_unused_value(value)?;
                reject_unused_action(action)?;
                Ok(Self::Visible)
            }
            "actionable" => {
                reject_unused_value(value)?;
                Ok(Self::Actionable(parse_actionability_action(action)?))
            }
            "value" => {
                reject_unused_action(action)?;
                value.map(Self::Value).ok_or_else(|| {
                    AppError::invalid_input_with_suggestion(
                        "--predicate value requires --value",
                        "Pass --value <expected> with --predicate value.",
                    )
                })
            }
            other => Err(AppError::invalid_input_with_suggestion(
                format!("Unknown wait predicate '{other}'"),
                "Use one of: exists, enabled, visible, actionable, value.",
            )),
        }
    }

    pub(crate) fn name(&self) -> &'static str {
        match self {
            Self::Exists => "exists",
            Self::Enabled => "enabled",
            Self::Visible => "visible",
            Self::Actionable(_) => "actionable",
            Self::Value(_) => "value",
        }
    }
}

/// Maps each `--action` name to the exact request its real command would
/// run with — policy included — so the preflight answers "would this action
/// succeed". Every name is an explicit arm: a catch-all here would let a
/// new action silently inherit the wrong policy.
fn parse_actionability_action(action: Option<&str>) -> Result<ActionRequest, AppError> {
    match action.unwrap_or("click") {
        "click" => Ok(ActionRequest::headless(Action::Click)),
        "type" => Ok(ActionRequest::headless(Action::TypeText(String::new()))),
        "set-value" => Ok(ActionRequest::headless(Action::SetValue(String::new()))),
        "clear" => Ok(ActionRequest::headless(Action::Clear)),
        other => Err(AppError::invalid_input_with_suggestion(
            format!("Unknown actionability action '{other}'"),
            "Use one of: click, type, set-value, clear.",
        )),
    }
}

fn reject_unused_action(action: Option<&str>) -> Result<(), AppError> {
    if action.is_none() {
        return Ok(());
    }
    Err(AppError::invalid_input_with_suggestion(
        "--action is only valid with --predicate actionable",
        "Remove --action or use --predicate actionable.",
    ))
}

pub(crate) fn observe(
    entry: &RefEntry,
    handle: &NativeHandle,
    predicate: &ElementPredicate,
    adapter: &dyn PlatformAdapter,
    deadline: crate::Deadline,
    stability: crate::actionability::StabilityExpectation,
) -> Result<Value, AdapterError> {
    match predicate {
        ElementPredicate::Exists => Ok(json!({ "exists": true })),
        ElementPredicate::Enabled => enabled(entry, handle, adapter, deadline),
        ElementPredicate::Visible => visible(entry, handle, adapter, deadline),
        ElementPredicate::Actionable(request) => {
            actionable(entry, handle, request, adapter, deadline, stability)
        }
        ElementPredicate::Value(expected) => value(entry, handle, expected, adapter, deadline),
    }
}

pub(crate) fn satisfied(predicate: &ElementPredicate, observed: &Value) -> bool {
    match predicate {
        ElementPredicate::Exists => observed["exists"].as_bool() == Some(true),
        ElementPredicate::Enabled => observed["enabled"].as_bool() == Some(true),
        ElementPredicate::Visible => observed["visible"].as_bool() == Some(true),
        ElementPredicate::Actionable(_) => observed["actionable"].as_bool() == Some(true),
        ElementPredicate::Value(_) => observed["matched"].as_bool() == Some(true),
    }
}

fn reject_unused_value(value: Option<String>) -> Result<(), AppError> {
    if value.is_none() {
        return Ok(());
    }
    Err(AppError::invalid_input_with_suggestion(
        "--value is only valid with --predicate value",
        "Remove --value or use --predicate value.",
    ))
}

fn enabled(
    _entry: &RefEntry,
    handle: &NativeHandle,
    adapter: &dyn PlatformAdapter,
    deadline: crate::Deadline,
) -> Result<Value, AdapterError> {
    let enabled = optional_live_read(adapter.get_live_state(handle, deadline))?
        .and_then(|state| state.enabled);
    Ok(json!({ "enabled": enabled, "applicable": enabled.is_some() }))
}

fn visible(
    _entry: &RefEntry,
    handle: &NativeHandle,
    adapter: &dyn PlatformAdapter,
    deadline: crate::Deadline,
) -> Result<Value, AdapterError> {
    let live = adapter.get_live_element(handle, deadline)?;
    let evidence = crate::tree::state::VisibilityEvidence {
        bounds: live.bounds,
        states: live.state.states,
        bounds_from_live: live.bounds.is_some(),
        states_from_live: true,
    };
    Ok(json!({
        "visible": evidence.result(),
        "applicable": evidence.applicable(),
    }))
}

fn actionable(
    entry: &RefEntry,
    handle: &NativeHandle,
    request: &ActionRequest,
    adapter: &dyn PlatformAdapter,
    deadline: crate::Deadline,
    stability: crate::actionability::StabilityExpectation,
) -> Result<Value, AdapterError> {
    match crate::actionability::check_live_with_stability(
        &crate::actionability::LiveCheckTarget {
            entry,
            handle,
            adapter,
            deadline,
        },
        request,
        stability,
    ) {
        Ok(report) => Ok(json!(report)),
        Err(err) if err.code == ErrorCode::ActionFailed => match err.details {
            Some(report) => Ok(report),
            None => Ok(json!({ "actionable": false, "error": err.message })),
        },
        Err(err) => Err(err),
    }
}

fn value(
    _entry: &RefEntry,
    handle: &NativeHandle,
    expected: &str,
    adapter: &dyn PlatformAdapter,
    deadline: crate::Deadline,
) -> Result<Value, AdapterError> {
    let observed = optional_live_read(adapter.get_live_value(handle, deadline))?;
    let matched = observed.as_deref() == Some(expected);
    Ok(json!({
        "matched": matched,
        "value_present": observed.is_some(),
        "value_chars": observed.as_ref().map(|value| value.chars().count()),
        "expected_chars": expected.chars().count()
    }))
}
