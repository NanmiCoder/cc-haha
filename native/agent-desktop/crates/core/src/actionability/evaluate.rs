use super::{
    evidence::ActionabilityEvidence, gates, receives_events::receives_events_check,
    report::ActionabilityReport, requirements::ActionabilityRequirements,
    stability::StabilityExpectation,
};
use crate::{
    AdapterError, ErrorCode,
    actions::action_request::ActionRequest,
    adapter::{NativeHandle, PlatformAdapter},
};
use serde_json::json;

#[cfg(test)]
use crate::refs::RefEntry;

#[cfg(test)]
pub(crate) fn check(
    entry: &RefEntry,
    request: &ActionRequest,
) -> Result<ActionabilityReport, AdapterError> {
    use crate::{
        adapter::hit_test::HitTestResult,
        adapter::{ActionOps, InputOps, ObservationOps, SystemOps},
    };

    struct TestHitAdapter;

    impl ObservationOps for TestHitAdapter {
        fn hit_test(
            &self,
            _handle: &NativeHandle,
            _point: crate::Point,
            _deadline: crate::Deadline,
        ) -> Result<HitTestResult, AdapterError> {
            Ok(HitTestResult::ReachesTarget)
        }
    }

    impl ActionOps for TestHitAdapter {}
    impl InputOps for TestHitAdapter {}
    impl SystemOps for TestHitAdapter {}

    let evidence = ActionabilityEvidence {
        nonspatial: false,
        state: crate::ElementState {
            role: entry.identity.role.clone(),
            states: entry.capabilities.states.clone(),
            value: entry.identity.value.clone(),
            enabled: Some(!crate::tree::state::has_state(
                &entry.capabilities.states,
                crate::tree::state::DISABLED,
            )),
            hidden: Some(crate::tree::state::has_state(
                &entry.capabilities.states,
                crate::tree::state::HIDDEN,
            )),
            offscreen: Some(crate::tree::state::has_state(
                &entry.capabilities.states,
                crate::tree::state::OFFSCREEN,
            )),
        },
        states_complete: true,
        bounds: entry.geometry.bounds,
        available_actions: entry.capabilities.available_actions.clone(),
    };
    let handle = NativeHandle::null();
    let adapter = TestHitAdapter;
    check_with_stability(
        StabilityExpectation::permissive(entry.geometry.bounds_hash),
        &evidence,
        request,
        Some((&handle, &adapter)),
        crate::Deadline::standard()?,
    )
}

pub(super) fn check_with_stability(
    stability: StabilityExpectation,
    evidence: &ActionabilityEvidence,
    request: &ActionRequest,
    hit_test: Option<(&NativeHandle, &dyn PlatformAdapter)>,
    deadline: crate::Deadline,
) -> Result<ActionabilityReport, AdapterError> {
    let report = build_report(stability, evidence, request, hit_test, deadline)?;
    finish(evidence, request, report)
}

/// Like [`check_with_stability`], but a report whose only unmet requirement
/// is `stable` is returned as `Ok` instead of converted to a terminal `Err`.
///
/// `stable_preflight` (`ref_action.rs`) samples live bounds to let a target
/// settle before deciding stability is truly unreachable; it can only make
/// that call by seeing the report, and `finish` below has already discarded
/// it into an error by the time a normal caller sees anything. Every other
/// gap - disabled, hidden, policy-denied, unsupported - still converts here,
/// unchanged, because no amount of sampling resolves those.
pub(super) fn check_with_stability_or_gap(
    stability: StabilityExpectation,
    evidence: &ActionabilityEvidence,
    request: &ActionRequest,
    hit_test: Option<(&NativeHandle, &dyn PlatformAdapter)>,
    deadline: crate::Deadline,
) -> Result<ActionabilityReport, AdapterError> {
    let report = build_report(stability, evidence, request, hit_test, deadline)?;
    if !report.actionable && report.only_blocking_check_is_stability() {
        return Ok(report);
    }
    finish(evidence, request, report)
}

pub(super) fn build_report(
    stability: StabilityExpectation,
    evidence: &ActionabilityEvidence,
    request: &ActionRequest,
    hit_test: Option<(&NativeHandle, &dyn PlatformAdapter)>,
    deadline: crate::Deadline,
) -> Result<ActionabilityReport, AdapterError> {
    let requirements = ActionabilityRequirements::for_action(&request.action);
    let pointer_delivery =
        requirements.pointer_delivery(&request.action, &evidence.available_actions, request.policy);
    let mut checks = Vec::new();
    let mut verified_point = None;
    let presentation_point = evidence.bounds.and_then(center_point);
    let without_pointer = requirements.delivered_without_pointer(
        request,
        &evidence.available_actions,
        pointer_delivery,
    );
    if requirements.visible {
        let requires_geometry =
            requirements.requires_geometry(request, &evidence.available_actions);
        let visibility = gates::visibility(evidence, requires_geometry, without_pointer);
        if requires_geometry
            && evidence.bounds.is_none()
            && matches!(
                visibility.status,
                super::status::ActionabilityStatus::Unknown
            )
            && let Some((handle, adapter)) = hit_test
            && let Some(refusal) = adapter.pointer_position_refusal(handle, deadline)
        {
            return Err(refusal);
        }
        checks.push(visibility);
    }
    if requirements.requires_stability(pointer_delivery) {
        checks.push(if without_pointer {
            gates::stability_without_pointer(evidence, stability)
        } else {
            gates::stability(stability, evidence.bounds)
        });
    }
    if requirements.enabled {
        checks.push(gates::enabled(evidence));
    }
    if requirements.editable {
        checks.push(gates::editable(evidence, &request.action));
    }
    checks.push(gates::action_supported(evidence, request));
    checks.push(gates::policy(request));
    if checks
        .iter()
        .any(|check| !matches!(check.status, super::status::ActionabilityStatus::Pass))
    {
        return Ok(ActionabilityReport::from_checks(
            checks,
            verified_point,
            presentation_point,
            evidence.bounds,
            pointer_delivery,
        ));
    }
    if matches!(pointer_delivery, super::PointerDelivery::Physical) {
        match hit_test {
            Some((handle, adapter)) => {
                let (check, point) =
                    receives_events_check(evidence.bounds, handle, adapter, request, deadline)?;
                checks.push(check);
                verified_point = point;
            }
            None => checks.push(super::check_result::unknown(
                "receives_events",
                "live hit-test context unavailable",
            )),
        }
    }
    Ok(ActionabilityReport::from_checks(
        checks,
        verified_point,
        presentation_point,
        evidence.bounds,
        pointer_delivery,
    ))
}

fn center_point(bounds: crate::Rect) -> Option<crate::Point> {
    bounds.validate().ok().and_then(|bounds| {
        (bounds.width > 0.0 && bounds.height > 0.0).then_some(crate::Point {
            x: bounds.x + bounds.width / 2.0,
            y: bounds.y + bounds.height / 2.0,
        })
    })
}

fn finish(
    evidence: &ActionabilityEvidence,
    request: &ActionRequest,
    report: ActionabilityReport,
) -> Result<ActionabilityReport, AdapterError> {
    if report.actionable {
        return Ok(report);
    }
    let code = report.terminal_code().unwrap_or(ErrorCode::ActionFailed);
    let suggestion = if code == ErrorCode::ActionFailed {
        "Wait for the target to become actionable, refresh the snapshot, or use an explicit physical/focus command if intended."
    } else if evidence.state.role == "cell"
        && report.checks.iter().any(|check| {
            check.check == "editable" && check.status == super::status::ActionabilityStatus::Fail
        })
    {
        "This cell is not directly editable. Activate it, take a fresh snapshot, and target the text editor if one appears."
    } else if code == ErrorCode::ActionNotSupported
        && matches!(request.action, crate::Action::SetFocus)
    {
        "Choose an element advertising SetFocus in a fresh snapshot. To focus the owning window instead, use focus-window."
    } else if code == ErrorCode::ActionNotSupported
        && matches!(
            request.action,
            crate::Action::SetValue(_) | crate::Action::Clear
        )
        && matches!(evidence.state.role.as_str(), "textfield" | "combobox")
    {
        if request.policy.is_headed() {
            "This field has no semantic text-write action. Use 'type' in the current headed mode for physical keyboard input; select the existing text first if you intend to replace it. If typing refuses because the field cannot be focused, use clipboard-set and the app's paste shortcut, then verify the field."
        } else {
            "This field has no semantic text-write action. Use '--headed type' for physical keyboard input; select the existing text first if you intend to replace it. If typing refuses because the field cannot be focused, use clipboard-set and the app's paste shortcut, then verify the field."
        }
    } else {
        "Waiting will not help: this element cannot satisfy the action as targeted. Target an element that advertises the action (check available_actions in a fresh snapshot). For a dropdown without select support, open it with click, inspect its choices, and use explicit keyboard input."
    };
    let mut details = json!(report);
    if let Some(object) = details.as_object_mut()
        && let Some(bounds) = evidence.bounds
    {
        if let Some(bounds_hash) = bounds.bounds_hash() {
            object.insert("observed_bounds_hash".into(), json!(bounds_hash));
        }
    }
    Err(AdapterError::new(
        code,
        format!("Target is not actionable: {}", report.failure_reasons()),
    )
    .with_details(details)
    .with_suggestion(suggestion)
    .with_disposition(crate::DeliverySemantics::not_delivered()))
}

#[cfg(test)]
#[path = "evaluate_recovery_tests.rs"]
mod recovery_tests;

#[cfg(test)]
#[path = "position_refusal_tests.rs"]
mod position_refusal_tests;

#[cfg(test)]
mod tests {
    use super::*;

    fn cell_evidence() -> ActionabilityEvidence {
        ActionabilityEvidence {
            nonspatial: false,
            state: crate::ElementState {
                role: "cell".to_string(),
                states: Vec::new(),
                value: None,
                enabled: None,
                hidden: None,
                offscreen: None,
            },
            states_complete: true,
            bounds: None,
            available_actions: Vec::new(),
        }
    }

    fn failed_editable_check() -> super::super::check::ActionabilityCheck {
        super::super::check::ActionabilityCheck {
            check: "editable",
            status: super::super::status::ActionabilityStatus::Fail,
            reason: None,
            occluder: None,
            terminal_code: Some(ErrorCode::ActionNotSupported),
            hit_test: None,
            stability: None,
        }
    }

    #[test]
    fn non_editable_cell_suggestion_does_not_promise_an_editor_exists() {
        let evidence = cell_evidence();
        let report = ActionabilityReport::from_checks(
            vec![failed_editable_check()],
            None,
            None,
            None,
            super::super::pointer_delivery::PointerDelivery::NotApplicable,
        );

        let request = ActionRequest::headed(crate::Action::SetValue("value".into()));
        let error =
            finish(&evidence, &request, report).expect_err("non-actionable report must fail");

        assert_eq!(
            error.suggestion.as_deref(),
            Some(
                "This cell is not directly editable. Activate it, take a fresh snapshot, and \
                 target the text editor if one appears."
            )
        );
        assert!(!error.suggestion.unwrap().contains("it exposes"));
    }

    #[test]
    fn unsupported_headed_select_does_not_suggest_repeating_headed_select() {
        let mut evidence = cell_evidence();
        evidence.state.role = "combobox".into();
        evidence.state.enabled = Some(true);
        evidence.state.hidden = Some(false);
        evidence.state.offscreen = Some(false);
        let error = check_with_stability(
            StabilityExpectation::permissive(None),
            &evidence,
            &ActionRequest::headed(crate::Action::Select("Manual Schedule".into())),
            None,
            crate::Deadline::standard().unwrap(),
        )
        .unwrap_err();
        assert_eq!(error.code, ErrorCode::ActionNotSupported);
        let suggestion = error.suggestion.unwrap();
        assert!(!suggestion.contains("--headed"));
        assert!(suggestion.contains("available_actions"));
    }
}
