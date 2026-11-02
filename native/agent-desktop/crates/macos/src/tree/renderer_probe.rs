use agent_desktop_core::{AdapterError, DeliverySemantics, ErrorCode};

pub(crate) const MANUAL: &str = "AXManualAccessibility";
pub(crate) const ENHANCED: &str = "AXEnhancedUserInterface";

pub(crate) fn activation_required(
    pid: i32,
    process_instance: &str,
    web_surface: bool,
    absence_proven: bool,
    deadline: std::time::Instant,
) -> Result<bool, AdapterError> {
    if !crate::system::process::process_identity::matches_instance(pid, process_instance)? {
        return Err(AdapterError::new(
            ErrorCode::StaleRef,
            "Renderer process instance changed before activation probing",
        )
        .with_suggestion("Run 'snapshot' to refresh, then retry with the updated ref.")
        .with_disposition(DeliverySemantics::not_delivered()));
    }
    let application = super::element_for_pid(pid);
    activation_needed(
        web_surface,
        absence_proven,
        |attribute| attribute_supported(&application, attribute, deadline),
        |attribute| super::surface_read::boolean(&application, attribute, deadline),
    )
}

fn activation_needed(
    web_surface: bool,
    absence_proven: bool,
    supported: impl FnMut(&str) -> Result<bool, AdapterError>,
    mut enabled: impl FnMut(&str) -> Result<Option<bool>, AdapterError>,
) -> Result<bool, AdapterError> {
    let Some(attribute) = choose_attribute(supported)? else {
        return Ok(false);
    };
    if attribute == MANUAL {
        return Ok(!web_surface && absence_proven);
    }
    let enabled = enabled(attribute)?;
    if !web_surface {
        return Ok(enabled == Some(false));
    }
    Ok(enabled.map_or(attribute == ENHANCED, |enabled| !enabled))
}

pub(crate) fn activation_attribute(
    application: &super::AXElement,
    deadline: std::time::Instant,
) -> Result<Option<&'static str>, AdapterError> {
    choose_attribute(|attribute| attribute_supported(application, attribute, deadline))
}

fn choose_attribute(
    mut supported: impl FnMut(&str) -> Result<bool, AdapterError>,
) -> Result<Option<&'static str>, AdapterError> {
    for attribute in [MANUAL, ENHANCED] {
        if supported(attribute)? {
            return Ok(Some(attribute));
        }
    }
    Ok(None)
}

fn attribute_supported(
    application: &super::AXElement,
    attribute: &str,
    deadline: std::time::Instant,
) -> Result<bool, AdapterError> {
    super::locator_deadline::prepare(application, deadline)?;
    let read = super::properties::capabilities::is_attr_settable_with_status(
        application,
        attribute,
        deadline,
    );
    super::locator_deadline::remaining(deadline)?;
    match (read.value, read.error) {
        (Some(value), None) => Ok(value),
        (None, Some(error)) if is_unsupported(error) => Ok(false),
        (None, Some(error)) if error == accessibility_sys::kAXErrorAPIDisabled => {
            Err(AdapterError::new(
                ErrorCode::PermDenied,
                "Accessibility API is disabled while probing renderer support",
            ))
        }
        (None, Some(error)) => Err(inconclusive_probe(error)),
        _ => Err(inconclusive_probe(accessibility_sys::kAXErrorFailure)),
    }
}

fn inconclusive_probe(error: i32) -> AdapterError {
    let code = match error {
        accessibility_sys::kAXErrorCannotComplete => ErrorCode::Timeout,
        accessibility_sys::kAXErrorInvalidUIElement => ErrorCode::StaleRef,
        _ => ErrorCode::AppUnresponsive,
    };
    AdapterError::new(
        code,
        "Renderer accessibility capability probe was inconclusive",
    )
    .with_details(serde_json::json!({
        "kind": "renderer_capability_probe",
        "ax_error": error,
        "complete": false,
        "retryable": true,
    }))
    .with_suggestion("Retry after the renderer accessibility tree finishes updating")
}

fn is_unsupported(error: i32) -> bool {
    matches!(
        error,
        accessibility_sys::kAXErrorAttributeUnsupported
            | accessibility_sys::kAXErrorNoValue
            | accessibility_sys::kAXErrorNotImplemented
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shallow_observation_requires_explicit_mode_evidence_not_renderer_absence() {
        for (mode, enabled, expected) in [
            (MANUAL, Some(false), false),
            (ENHANCED, Some(false), true),
            (ENHANCED, Some(true), false),
            (ENHANCED, None, false),
        ] {
            assert_eq!(
                activation_needed(
                    false,
                    false,
                    |attribute| Ok(attribute == mode),
                    |_| {
                        assert_ne!(mode, MANUAL);
                        Ok(enabled)
                    },
                )
                .unwrap(),
                expected
            );
        }
    }

    #[test]
    fn readable_web_tree_still_requires_enhanced_mode_when_disabled() {
        for (enabled, expected) in [(Some(false), true), (Some(true), false), (None, true)] {
            let required = activation_needed(
                true,
                true,
                |attribute| Ok(attribute == ENHANCED),
                |attribute| {
                    assert_eq!(attribute, ENHANCED);
                    Ok(enabled)
                },
            )
            .unwrap();
            assert_eq!(required, expected);
        }
    }

    #[test]
    fn native_enhanced_mode_requires_explicit_disabled_readback() {
        for (enabled, expected) in [(Some(false), true), (Some(true), false), (None, false)] {
            assert_eq!(
                activation_needed(
                    false,
                    true,
                    |attribute| Ok(attribute == ENHANCED),
                    |_| Ok(enabled),
                )
                .unwrap(),
                expected
            );
        }
    }

    #[test]
    fn legacy_renderer_without_a_web_surface_keeps_activation_retry() {
        assert!(
            activation_needed(
                false,
                true,
                |attribute| Ok(attribute == MANUAL),
                |_| panic!("a missing renderer must continue waiting for its tree"),
            )
            .unwrap()
        );
    }

    #[test]
    fn readable_legacy_renderer_does_not_require_a_readable_manual_flag() {
        assert!(
            !activation_needed(
                true,
                true,
                |attribute| Ok(attribute == MANUAL),
                |_| Ok(None),
            )
            .unwrap()
        );
    }

    #[test]
    fn readable_manual_renderer_ignores_an_unconfirmed_manual_flag() {
        for absence_proven in [false, true] {
            assert!(
                !activation_needed(
                    true,
                    absence_proven,
                    |attribute| Ok(attribute == MANUAL),
                    |_| Ok(Some(false)),
                )
                .unwrap()
            );
        }
    }

    #[test]
    fn unsupported_renderer_does_not_read_an_activation_value() {
        assert!(
            !activation_needed(
                true,
                true,
                |_| Ok(false),
                |_| panic!("unsupported attributes must not be read"),
            )
            .unwrap()
        );
    }

    #[test]
    fn activation_value_errors_are_not_treated_as_disabled_mode() {
        for code in [
            ErrorCode::PermDenied,
            ErrorCode::Timeout,
            ErrorCode::StaleRef,
        ] {
            let error = activation_needed(
                true,
                true,
                |attribute| Ok(attribute == ENHANCED),
                |_| Err(AdapterError::new(code.clone(), "read failed")),
            )
            .unwrap_err();
            assert_eq!(error.code, code);
        }
    }

    #[test]
    fn enhanced_activation_is_available_to_native_apps_that_advertise_it() {
        let mut queried = Vec::new();
        assert_eq!(
            choose_attribute(|attribute| {
                queried.push(attribute.to_owned());
                Ok(attribute == ENHANCED)
            })
            .unwrap(),
            Some(ENHANCED)
        );
        assert_eq!(queried, [MANUAL, ENHANCED]);
        assert_eq!(
            choose_attribute(|attribute| Ok(attribute == ENHANCED)).unwrap(),
            Some(ENHANCED)
        );
    }

    #[test]
    fn manual_activation_keeps_precedence_and_does_not_require_a_web_surface() {
        {
            let mut queried = Vec::new();
            assert_eq!(
                choose_attribute(|attribute| {
                    queried.push(attribute.to_owned());
                    Ok(true)
                })
                .unwrap(),
                Some(MANUAL)
            );
            assert_eq!(queried, [MANUAL]);
        }
    }

    #[test]
    fn inconclusive_manual_probe_does_not_fall_through_to_another_mutation() {
        let error = choose_attribute(|_| {
            Err(inconclusive_probe(
                accessibility_sys::kAXErrorCannotComplete,
            ))
        })
        .unwrap_err();
        assert_eq!(error.code, ErrorCode::Timeout);
    }

    #[test]
    fn unsupported_probe_results_do_not_request_activation() {
        for error in [
            accessibility_sys::kAXErrorAttributeUnsupported,
            accessibility_sys::kAXErrorNoValue,
            accessibility_sys::kAXErrorNotImplemented,
        ] {
            assert!(is_unsupported(error));
        }
        assert!(!is_unsupported(accessibility_sys::kAXErrorCannotComplete));
    }

    #[test]
    fn transient_probe_failures_are_never_collapsed_to_unsupported() {
        let error = inconclusive_probe(accessibility_sys::kAXErrorCannotComplete);

        assert_eq!(error.code, ErrorCode::Timeout);
        assert_eq!(error.details.unwrap()["complete"], false);
    }
}
