use super::{
    check::ActionabilityCheck,
    check_result::{fail, fail_terminal, pass, unknown},
    evidence::ActionabilityEvidence,
};
use crate::{
    ErrorCode, Rect, actions::action::Action, actions::action_request::ActionRequest,
    actions::capability,
};

pub(super) fn visibility(
    evidence: &ActionabilityEvidence,
    requires_geometry: bool,
    delivered_without_pointer: bool,
) -> ActionabilityCheck {
    match evidence.state.hidden {
        Some(true) => return fail("visible", "live hidden state is true"),
        None if !evidence.states_complete => {
            return unknown("visible", "live hidden state unavailable");
        }
        None if crate::tree::state::has_state(
            &evidence.state.states,
            crate::tree::state::HIDDEN,
        ) =>
        {
            return fail("visible", "canonical hidden state is present");
        }
        None => {}
        Some(false) => {}
    }
    match evidence.state.offscreen {
        Some(true) => return fail("visible", "live offscreen state is true"),
        None if !evidence.states_complete => {
            return unknown("visible", "live offscreen state unavailable");
        }
        None if crate::tree::state::has_state(
            &evidence.state.states,
            crate::tree::state::OFFSCREEN,
        ) =>
        {
            return fail("visible", "canonical offscreen state is present");
        }
        None => {}
        Some(false) => {}
    }
    if delivered_without_pointer
        && evidence.nonspatial
        && evidence.states_complete
        && evidence.state.hidden == Some(false)
    {
        return pass("visible");
    }
    if !requires_geometry && evidence.state.offscreen.is_none() && evidence.bounds.is_some() {
        return pass("visible");
    }
    if (!requires_geometry || delivered_without_pointer)
        && evidence.bounds.is_none()
        && evidence.state.visible_without_bounds() == Some(true)
    {
        return pass("visible");
    }
    let Some(bounds) = evidence.bounds else {
        return unknown("visible", "bounds unavailable");
    };
    if !bounds_are_visible(Some(bounds)) {
        return fail("visible", "bounds are zero-sized");
    }
    pass("visible")
}

pub(super) fn stability_without_pointer(
    evidence: &ActionabilityEvidence,
    expectation: super::stability::StabilityExpectation,
) -> ActionabilityCheck {
    if evidence.bounds.is_none() && evidence.state.offscreen == Some(false) {
        let mut check = pass("stable");
        check.reason = Some("no pointer use; not measurable without bounds".to_owned());
        return check;
    }
    stability(expectation, evidence.bounds)
}

pub(super) fn stability(
    expectation: super::stability::StabilityExpectation,
    bounds: Option<Rect>,
) -> ActionabilityCheck {
    let evidence = super::stability_evidence::StabilityEvidence {
        samples: expectation.samples,
        span_ms: expectation.span_ms,
    };
    let Some(bounds) = bounds else {
        let mut check = unknown("stable", "live bounds unavailable");
        check.stability = Some(evidence);
        return check;
    };
    let check = if expectation.strict {
        if let Some(expected) = expectation.bounds {
            if super::stability_sampler::geometry_matches(expected, bounds) {
                pass("stable")
            } else {
                fail("stable", "bounds changed after the stability window")
            }
        } else if let Some(expected_hash) = expectation.bounds_hash {
            if bounds.bounds_hash() == Some(expected_hash) {
                pass("stable")
            } else {
                fail("stable", "bounds changed since the previous observation")
            }
        } else {
            fail("stable", "waiting for stable live bounds observations")
        }
    } else {
        let Some(expected) = expectation.bounds_hash else {
            let mut check = unknown("stable", "snapshot bounds hash unavailable");
            check.stability = Some(evidence);
            return check;
        };
        let Some(observed_hash) = bounds.bounds_hash() else {
            let mut check = unknown("stable", "live bounds are invalid");
            check.stability = Some(evidence);
            return check;
        };
        if observed_hash == expected {
            pass("stable")
        } else {
            unknown("stable", "live bounds stability has not been sampled")
        }
    };
    let mut check = check;
    check.stability = Some(evidence);
    check
}

pub(super) fn enabled(evidence: &ActionabilityEvidence) -> ActionabilityCheck {
    match evidence.state.enabled {
        Some(true) => pass("enabled"),
        Some(false) => fail("enabled", "live enabled state is false"),
        None => unknown("enabled", "live enabled state unavailable"),
    }
}

pub(super) fn action_supported(
    evidence: &ActionabilityEvidence,
    request: &ActionRequest,
) -> ActionabilityCheck {
    if request.action.requires_cursor_policy() {
        return pass("supported_action");
    }
    if matches!(request.action, Action::ScrollTo) {
        return pass("supported_action");
    }
    if matches!(request.action, Action::Click | Action::RightClick) {
        if capability::supports_direct_semantic_pointer_delivery(
            &request.action,
            &evidence.available_actions,
        ) {
            return pass("supported_action");
        }
        if request.policy.allow_cursor_move && request.policy.allow_focus_steal {
            return pass("supported_action");
        }
        return fail_terminal(
            "supported_action",
            "direct semantic delivery is unavailable and physical fallback is denied",
            ErrorCode::PolicyDenied,
        );
    }
    if matches!(request.action, Action::DoubleClick | Action::TripleClick) {
        if request.policy.allow_cursor_move && request.policy.allow_focus_steal {
            return pass("supported_action");
        }
        return fail_terminal(
            "supported_action",
            "semantic gesture is unavailable and physical fallback is denied",
            ErrorCode::PolicyDenied,
        );
    }
    if matches!(request.action, Action::Select(_)) && combo_select_applies(evidence) {
        return pass("supported_action");
    }
    if capability::contains_any(
        &evidence.available_actions,
        capability::for_action(&request.action),
    ) {
        return pass("supported_action");
    }
    if request.action.may_use_focus_fallback() && request.policy.allow_focus_steal {
        return pass("supported_action");
    }
    if request.action.may_use_focus_fallback() {
        return fail_terminal(
            "supported_action",
            "semantic action is unavailable and focus fallback is denied",
            ErrorCode::PolicyDenied,
        );
    }
    let expected = capability::for_action(&request.action).join(" or ");
    fail_terminal(
        "supported_action",
        format!("{expected} is not available"),
        ErrorCode::ActionNotSupported,
    )
}

pub(super) fn policy(request: &ActionRequest) -> ActionabilityCheck {
    if request.action.requires_cursor_policy() && !request.policy.allow_cursor_move {
        return fail_terminal(
            "policy",
            "action requires cursor movement but policy denies it",
            ErrorCode::PolicyDenied,
        );
    }
    pass("policy")
}

pub(super) fn editable(evidence: &ActionabilityEvidence, action: &Action) -> ActionabilityCheck {
    if !matches!(
        action,
        Action::SetValue(_) | Action::TypeText(_) | Action::Clear
    ) {
        return pass("editable");
    }
    if evidence.state.role == "textfield" || evidence.state.role == "combobox" {
        return pass("editable");
    }
    if capability::contains(&evidence.available_actions, capability::SET_VALUE) {
        return pass("editable");
    }
    fail_terminal(
        "editable",
        format!("role {} is not editable", evidence.state.role),
        ErrorCode::ActionNotSupported,
    )
}

fn combo_select_applies(evidence: &ActionabilityEvidence) -> bool {
    evidence.state.role == "combobox"
        && capability::contains_any(
            &evidence.available_actions,
            capability::EXPANDED_APPLICABILITY,
        )
}

#[cfg(test)]
pub(crate) fn states_are_enabled(states: &[String]) -> bool {
    !crate::tree::state::has_state(states, crate::tree::state::DISABLED)
}

pub(crate) fn bounds_are_visible(bounds: Option<Rect>) -> bool {
    bounds.is_some_and(|bounds| {
        bounds.validate().is_ok() && bounds.width > 0.0 && bounds.height > 0.0
    })
}

#[cfg(test)]
#[path = "gates_tests.rs"]
mod tests;
