use agent_desktop_core::{AdapterError, ErrorCode};

pub(crate) use super::ax_perform::{advertises_action, perform_observed_action};

#[cfg(target_os = "macos")]
mod imp {
    use super::*;
    use crate::actions::ax_mutation;
    use crate::tree::AXElement;
    use accessibility_sys::{kAXErrorSuccess, kAXFocusedAttribute, kAXValueAttribute};
    use core_foundation::{
        base::{CFType, TCFType},
        boolean::CFBoolean,
        number::CFNumber,
        string::CFString,
    };

    pub(crate) fn try_ax_action_or_err(
        el: &AXElement,
        name: &str,
        deadline: agent_desktop_core::Deadline,
    ) -> Result<bool, AdapterError> {
        if advertises_action(el, name, deadline) == Some(false) {
            return Ok(false);
        }
        let action = CFString::new(name);
        run_mutation(el, name, ax_mutation::PERFORM_API, deadline, |deadline| {
            crate::tree::properties::ax_ipc::perform_action(
                el,
                action.as_concrete_TypeRef(),
                deadline,
            )
        })
    }

    pub(crate) fn set_ax_bool_or_err(
        el: &AXElement,
        attr: &str,
        value: bool,
        deadline: agent_desktop_core::Deadline,
    ) -> Result<bool, AdapterError> {
        let cf_attr = CFString::new(attr);
        let cf_val = if value {
            CFBoolean::true_value()
        } else {
            CFBoolean::false_value()
        };
        run_mutation(
            el,
            attr,
            "AXUIElementSetAttributeValue",
            deadline,
            |deadline| {
                crate::tree::properties::ax_ipc::set_attribute_value(
                    el,
                    cf_attr.as_concrete_TypeRef(),
                    cf_val.as_CFTypeRef(),
                    deadline,
                )
            },
        )
    }

    pub(crate) fn set_ax_string_or_err(
        el: &AXElement,
        attr: &str,
        value: &str,
        deadline: agent_desktop_core::Deadline,
    ) -> Result<(), AdapterError> {
        let cf_attr = CFString::new(attr);
        let cf_val = CFString::new(value);
        let delivered = run_mutation(
            el,
            attr,
            "AXUIElementSetAttributeValue",
            deadline,
            |deadline| {
                crate::tree::properties::ax_ipc::set_attribute_value(
                    el,
                    cf_attr.as_concrete_TypeRef(),
                    cf_val.as_CFTypeRef(),
                    deadline,
                )
            },
        )?;
        if !delivered {
            return Err(AdapterError::new(
                ErrorCode::ActionFailed,
                format!("AXSetAttributeValue({attr}) is unsupported"),
            )
            .with_disposition(agent_desktop_core::DeliverySemantics::not_delivered())
            .with_suggestion("Attribute may be read-only. Try 'click' or 'type' instead."));
        }
        Ok(())
    }

    pub(crate) fn is_attr_settable(
        el: &AXElement,
        attr: &str,
        deadline: agent_desktop_core::Deadline,
    ) -> Result<bool, AdapterError> {
        let cf_attr = CFString::new(attr);
        let (err, settable) = crate::tree::properties::ax_ipc::is_attribute_settable(
            el,
            cf_attr.as_concrete_TypeRef(),
            deadline,
        );
        ensure_read_finished(deadline)?;
        classify_settable_read(attr, err, settable)
    }

    pub(crate) fn ax_focus_or_err(
        el: &AXElement,
        deadline: agent_desktop_core::Deadline,
    ) -> Result<bool, AdapterError> {
        set_ax_bool_or_err(el, kAXFocusedAttribute, true, deadline)
    }

    /// Sets `AXValue` with a CoreFoundation type matching the element's
    /// current value: numeric controls (sliders, steppers, progress) hold a
    /// `CFNumber` and reject a `CFString`, so a typed write is required. Falls
    /// back to a string write when the current value is a string or absent.
    pub(crate) fn set_ax_value_coerced(
        el: &AXElement,
        value: &str,
        deadline: agent_desktop_core::Deadline,
    ) -> Result<(), AdapterError> {
        let cf_attr = CFString::new(kAXValueAttribute);
        let (read, current) = crate::tree::properties::ax_ipc::copy_attribute_value(
            el,
            cf_attr.as_concrete_TypeRef(),
            deadline,
        );
        ensure_read_finished(deadline)?;
        if read != kAXErrorSuccess {
            if !current.is_null() {
                unsafe { core_foundation::base::CFRelease(current) };
            }
            if read != accessibility_sys::kAXErrorAttributeUnsupported
                && read != accessibility_sys::kAXErrorNoValue
            {
                return Err(read_failure(kAXValueAttribute, read));
            }
        }
        let coerced: Option<CFType> = if read == kAXErrorSuccess && !current.is_null() {
            let cur = unsafe { CFType::wrap_under_create_rule(current) };
            if cur.downcast::<CFNumber>().is_some() {
                Some(number_cf_from_str(value)?)
            } else if cur.downcast::<CFBoolean>().is_some() {
                let truthy = matches!(value, "1" | "true" | "True" | "on" | "yes");
                Some(CFBoolean::from(truthy).as_CFType())
            } else {
                None
            }
        } else {
            None
        };

        match coerced {
            Some(cf_value) => {
                let delivered = run_mutation(
                    el,
                    kAXValueAttribute,
                    "AXUIElementSetAttributeValue",
                    deadline,
                    |deadline| {
                        crate::tree::properties::ax_ipc::set_attribute_value(
                            el,
                            cf_attr.as_concrete_TypeRef(),
                            cf_value.as_CFTypeRef(),
                            deadline,
                        )
                    },
                )?;
                if !delivered {
                    return Err(AdapterError::new(
                        ErrorCode::ActionFailed,
                        "AXSetAttributeValue(AXValue) is unsupported",
                    )
                    .with_disposition(agent_desktop_core::DeliverySemantics::not_delivered())
                    .with_suggestion(
                        "Value may be read-only or out of range. Try 'click' to focus then arrow keys.",
                    ));
                }
                Ok(())
            }
            None => set_ax_string_or_err(el, kAXValueAttribute, value, deadline),
        }
    }

    fn prepare(
        element: &AXElement,
        deadline: agent_desktop_core::Deadline,
    ) -> Result<(), AdapterError> {
        crate::tree::properties::attributes::set_messaging_timeout(element, deadline)
    }

    fn run_mutation(
        element: &AXElement,
        operation: &str,
        api: &str,
        deadline: agent_desktop_core::Deadline,
        mutate: impl FnOnce(agent_desktop_core::Deadline) -> Result<i32, AdapterError>,
    ) -> Result<bool, AdapterError> {
        let error = mutate(deadline)?;
        let delivered = ax_mutation::classify_result(element, operation, api, error)?;
        if deadline.is_expired() {
            let disposition = if delivered {
                agent_desktop_core::DeliverySemantics::delivered_unverified()
            } else {
                agent_desktop_core::DeliverySemantics::not_delivered()
            };
            return Err(deadline.timeout_error().with_disposition(disposition));
        }
        Ok(delivered)
    }

    fn classify_settable_read(
        attribute: &str,
        error: i32,
        settable: bool,
    ) -> Result<bool, AdapterError> {
        if error == kAXErrorSuccess {
            return Ok(settable);
        }
        if crate::tree::properties::ax_absence::is_absent_attribute_error(error) {
            return Ok(false);
        }
        Err(read_failure(attribute, error))
    }

    fn read_failure(attribute: &str, error: i32) -> AdapterError {
        use accessibility_sys::{
            kAXErrorAPIDisabled, kAXErrorCannotComplete, kAXErrorInvalidUIElement,
        };
        let code = if error == kAXErrorAPIDisabled {
            ErrorCode::PermDenied
        } else if error == kAXErrorInvalidUIElement {
            ErrorCode::StaleRef
        } else if error == kAXErrorCannotComplete {
            ErrorCode::AppUnresponsive
        } else {
            ErrorCode::ActionFailed
        };
        AdapterError::new(code, format!("Accessibility read failed for {attribute}"))
            .with_details(serde_json::json!({
                "attribute": attribute,
                "ax_error": error,
                "retryable": error == kAXErrorCannotComplete,
            }))
            .with_disposition(agent_desktop_core::DeliverySemantics::not_delivered())
    }

    fn ensure_read_finished(deadline: agent_desktop_core::Deadline) -> Result<(), AdapterError> {
        if deadline.is_expired() {
            Err(deadline
                .timeout_error()
                .with_disposition(agent_desktop_core::DeliverySemantics::not_delivered()))
        } else {
            Ok(())
        }
    }

    fn number_cf_from_str(value: &str) -> Result<CFType, AdapterError> {
        if let Ok(i) = value.parse::<i64>() {
            return Ok(CFNumber::from(i).as_CFType());
        }
        if let Ok(f) = value.parse::<f64>() {
            return Ok(CFNumber::from(f).as_CFType());
        }
        Err(AdapterError::new(
            ErrorCode::InvalidArgs,
            format!(
                "The requested value ({} chars) is not a number; this control holds a numeric value",
                value.chars().count()
            ),
        )
        .with_suggestion("Pass a numeric value, e.g. set-value @s8f3k2p9:e1 50"))
    }

    pub(crate) fn element_role(
        el: &AXElement,
        deadline: agent_desktop_core::Deadline,
    ) -> Result<Option<String>, AdapterError> {
        use accessibility_sys::kAXRoleAttribute;
        prepare(el, deadline)?;
        let read_deadline = crate::tree::properties::ax_ipc::AxDeadline::absolute(deadline)?;
        let role = crate::tree::read_recovery::read(read_deadline, || {
            crate::tree::properties::attributes::copy_string_attr_result(
                el,
                kAXRoleAttribute,
                read_deadline,
            )
        })
        .map_err(|error| read_failure(kAXRoleAttribute, error))?;
        ensure_read_finished(deadline)?;
        Ok(role.map(|role| crate::tree::roles::ax_role_to_str(&role).to_string()))
    }

    #[cfg(test)]
    mod settable_tests {
        use super::classify_settable_read;

        #[test]
        fn an_unanswerable_settability_probe_reads_as_not_settable() {
            for error in [
                accessibility_sys::kAXErrorFailure,
                accessibility_sys::kAXErrorAttributeUnsupported,
                accessibility_sys::kAXErrorNoValue,
                accessibility_sys::kAXErrorNotImplemented,
            ] {
                assert_eq!(
                    classify_settable_read("AXSelected", error, false).ok(),
                    Some(false),
                    "a probe that cannot be answered means do not attempt the write, \
                     not fail the command"
                );
            }
        }

        #[test]
        fn a_transport_failure_still_fails_the_settability_probe() {
            for error in [
                accessibility_sys::kAXErrorCannotComplete,
                accessibility_sys::kAXErrorInvalidUIElement,
                accessibility_sys::kAXErrorAPIDisabled,
            ] {
                assert!(classify_settable_read("AXSelected", error, false).is_err());
            }
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    use super::*;
    use crate::tree::AXElement;

    pub fn try_ax_action_or_err(
        _el: &AXElement,
        _name: &str,
        _deadline: agent_desktop_core::Deadline,
    ) -> Result<bool, AdapterError> {
        Ok(false)
    }
    pub fn set_ax_bool_or_err(
        _el: &AXElement,
        _attr: &str,
        _value: bool,
        _deadline: agent_desktop_core::Deadline,
    ) -> Result<bool, AdapterError> {
        Ok(false)
    }
    pub fn set_ax_string_or_err(
        _el: &AXElement,
        _attr: &str,
        _value: &str,
        _deadline: agent_desktop_core::Deadline,
    ) -> Result<(), AdapterError> {
        Err(AdapterError::not_supported("set_ax_string_or_err"))
    }
    pub fn is_attr_settable(
        _el: &AXElement,
        _attr: &str,
        _deadline: agent_desktop_core::Deadline,
    ) -> Result<bool, AdapterError> {
        Ok(false)
    }
    pub fn ax_focus_or_err(
        _el: &AXElement,
        _deadline: agent_desktop_core::Deadline,
    ) -> Result<bool, AdapterError> {
        Ok(false)
    }
    pub fn set_ax_value_coerced(
        _el: &AXElement,
        _value: &str,
        _deadline: agent_desktop_core::Deadline,
    ) -> Result<(), AdapterError> {
        Err(AdapterError::not_supported("set_ax_value_coerced"))
    }
    pub fn element_role(
        _el: &AXElement,
        _deadline: agent_desktop_core::Deadline,
    ) -> Result<Option<String>, AdapterError> {
        Ok(None)
    }
}

pub(crate) use imp::{
    ax_focus_or_err, element_role, is_attr_settable, set_ax_bool_or_err, set_ax_string_or_err,
    set_ax_value_coerced, try_ax_action_or_err,
};
