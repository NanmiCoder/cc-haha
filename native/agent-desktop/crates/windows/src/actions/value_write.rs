//! ValuePattern / RangeValuePattern writes for `SetValue` and `Clear`.
//!
//! Verification re-reads route through [`gated_pattern_value_equals`] /
//! [`gated_pattern_range_equals`] so an `IsPassword` element never calls
//! `get_value` (A19-3). Error echoes carry `value_chars` counts, never text.

use agent_desktop_core::{
    ActionStep, AdapterError, Deadline, DeliverySemantics, ErrorCode, InteractionPolicy,
};

use crate::actions::chain::{ChainDef, ChainRung, DeliveryOutcome, execute_chain};
use crate::tree::element::UIAElement;

pub(crate) const VALUE_LABEL: &str = "ValuePattern.SetValue";
pub(crate) const RANGE_LABEL: &str = "RangeValuePattern.SetValue";

pub(crate) const VALUE_WRITE_CHAIN: ChainDef = ChainDef {
    suggestion: "Refresh the snapshot and retry, or target a writable Value or RangeValue control.",
    continue_after_unverified_delivery: false,
};

pub(crate) const CLEAR_CHAIN: ChainDef = ChainDef {
    suggestion: "Refresh the snapshot and retry, or target a writable Value control.",
    continue_after_unverified_delivery: false,
};

/// Injected SetValue plan: the value plus rung availability, bundled so
/// `set_value_judged_for` stays within the 5-parameter cap.
pub(crate) struct SetValuePlan<'a> {
    pub(crate) value: &'a str,
    pub(crate) value_writable: bool,
    pub(crate) range_available: bool,
}

#[cfg(target_os = "windows")]
mod imp {
    use super::{
        ActionStep, AdapterError, CLEAR_CHAIN, ChainRung, Deadline, DeliveryOutcome,
        DeliverySemantics, ErrorCode, InteractionPolicy, RANGE_LABEL, SetValuePlan, UIAElement,
        VALUE_LABEL, VALUE_WRITE_CHAIN, execute_chain,
    };
    use crate::actions::chain::{after_delivery, gated};
    use crate::actions::mutation::{classify_success, classify_write};
    use crate::tree::properties::element_properties::ElementProperties;
    use crate::tree::properties::property_ids::TreeProperty;
    use crate::tree::properties::property_outcome::PropertyOutcome;
    use crate::tree::properties::read_one;
    use uiautomation::patterns::{UIRangeValuePattern, UIValuePattern};

    pub(crate) fn set_value_steps(
        element: &UIAElement,
        value: &str,
        policy: InteractionPolicy,
        deadline: Deadline,
    ) -> Result<Vec<ActionStep>, AdapterError> {
        let parsed = parse_finite_f64(value);
        set_value_judged_for(
            deadline,
            policy,
            SetValuePlan {
                value,
                value_writable: value_writable(element),
                range_available: range_available(element),
            },
            || invoke_value_set(element, value),
            || match parsed {
                Some(target) => invoke_range_set(element, target),
                None => Ok(DeliveryOutcome::NotDelivered),
            },
        )
    }

    pub(crate) fn clear_steps(
        element: &UIAElement,
        policy: InteractionPolicy,
        deadline: Deadline,
    ) -> Result<Vec<ActionStep>, AdapterError> {
        let value_ok = value_writable(element);
        clear_judged_for(deadline, policy, value_ok, || invoke_value_set(element, ""))
            .map_err(|error| attach_value_chars(error, ""))
    }

    /// Injected SetValue chain — unit-test seam and live path.
    pub(crate) fn set_value_judged_for(
        deadline: Deadline,
        policy: InteractionPolicy,
        plan: SetValuePlan<'_>,
        mut value_write: impl FnMut() -> Result<DeliveryOutcome, AdapterError>,
        mut range_write: impl FnMut() -> Result<DeliveryOutcome, AdapterError>,
    ) -> Result<Vec<ActionStep>, AdapterError> {
        let parsed = parse_finite_f64(plan.value);
        let mut value_run = gated(plan.value_writable, &mut value_write);
        let mut range_run = gated(plan.range_available && parsed.is_some(), &mut range_write);
        execute_chain(
            deadline,
            &VALUE_WRITE_CHAIN,
            policy,
            &mut [
                ChainRung {
                    label: VALUE_LABEL,
                    requires_headed: false,
                    run: &mut value_run,
                },
                ChainRung {
                    label: RANGE_LABEL,
                    requires_headed: false,
                    run: &mut range_run,
                },
            ],
        )
        .map_err(|error| attach_value_chars(error, plan.value))
    }

    /// Injected Clear chain — unit-test seam and live path.
    pub(crate) fn clear_judged_for(
        deadline: Deadline,
        policy: InteractionPolicy,
        value_writable: bool,
        mut value_write: impl FnMut() -> Result<DeliveryOutcome, AdapterError>,
    ) -> Result<Vec<ActionStep>, AdapterError> {
        let mut value_run = gated(value_writable, &mut value_write);
        execute_chain(
            deadline,
            &CLEAR_CHAIN,
            policy,
            &mut [ChainRung {
                label: VALUE_LABEL,
                requires_headed: false,
                run: &mut value_run,
            }],
        )
    }

    pub(crate) fn value_writable(element: &UIAElement) -> bool {
        read_one(element, TreeProperty::ValueAvailable).flag() == Some(true)
            && read_one(element, TreeProperty::ValueIsReadOnly).flag() == Some(false)
    }

    pub(crate) fn range_available(element: &UIAElement) -> bool {
        read_one(element, TreeProperty::RangeValueAvailable).flag() == Some(true)
    }

    pub(crate) fn parse_finite_f64(value: &str) -> Option<f64> {
        value
            .parse::<f64>()
            .ok()
            .filter(|number| number.is_finite())
    }

    fn invoke_value_set(
        element: &UIAElement,
        value: &str,
    ) -> Result<DeliveryOutcome, AdapterError> {
        let delivered = match element.0.get_pattern::<UIValuePattern>() {
            Ok(pattern) => match pattern.set_value(value) {
                Ok(()) => classify_success()?,
                Err(error) => classify_write("SetValue", VALUE_LABEL, &error)?,
            },
            Err(error) => classify_write("get_pattern", VALUE_LABEL, &error)?,
        };
        if !delivered {
            return Ok(DeliveryOutcome::NotDelivered);
        }
        let verified = gated_pattern_value_equals(element, value).map_err(after_delivery)?;
        Ok(DeliveryOutcome::from_observation(verified))
    }

    fn invoke_range_set(
        element: &UIAElement,
        target: f64,
    ) -> Result<DeliveryOutcome, AdapterError> {
        let pattern = match element.0.get_pattern::<UIRangeValuePattern>() {
            Ok(pattern) => pattern,
            Err(error) => {
                return Ok(DeliveryOutcome::from_delivery(
                    classify_write("get_pattern", RANGE_LABEL, &error)?,
                    false,
                ));
            }
        };
        match pattern.is_readonly() {
            Ok(true) => return Ok(DeliveryOutcome::NotDelivered),
            Ok(false) => {}
            Err(error) => {
                return Ok(DeliveryOutcome::from_delivery(
                    classify_write("IsReadOnly", RANGE_LABEL, &error)?,
                    false,
                ));
            }
        }
        let delivered = match pattern.set_value(target) {
            Ok(()) => classify_success()?,
            Err(error) => classify_write("SetValue", RANGE_LABEL, &error)?,
        };
        if !delivered {
            return Ok(DeliveryOutcome::NotDelivered);
        }
        let verified = gated_pattern_range_equals(element, target).map_err(after_delivery)?;
        Ok(DeliveryOutcome::from_observation(verified))
    }

    /// IsPassword-gated ValuePattern readback. The only `UIValuePattern::get_value`
    /// call site under `actions/`.
    pub(crate) fn gated_pattern_value_equals(
        element: &UIAElement,
        expected: &str,
    ) -> Result<Option<bool>, AdapterError> {
        gated_value_compare(
            read_one(element, TreeProperty::IsPassword),
            expected,
            || {
                let pattern = element
                    .0
                    .get_pattern::<UIValuePattern>()
                    .map_err(|error| read_failed("ValuePattern.get_value", &error))?;
                pattern
                    .get_value()
                    .map_err(|error| read_failed("ValuePattern.get_value", &error))
            },
        )
    }

    /// IsPassword-gated RangeValuePattern readback. The only
    /// `UIRangeValuePattern::get_value` call site under `actions/`.
    pub(crate) fn gated_pattern_range_equals(
        element: &UIAElement,
        expected: f64,
    ) -> Result<Option<bool>, AdapterError> {
        gated_range_compare(
            read_one(element, TreeProperty::IsPassword),
            expected,
            || {
                let pattern = element
                    .0
                    .get_pattern::<UIRangeValuePattern>()
                    .map_err(|error| read_failed("RangeValuePattern.get_value", &error))?;
                pattern
                    .get_value()
                    .map_err(|error| read_failed("RangeValuePattern.get_value", &error))
            },
        )
    }

    /// Shared secure-field gate: withholds the comparison on a secure field
    /// rather than reading it, otherwise reads once and compares. Generic
    /// over the compared type so [`gated_value_compare`]'s `String` read
    /// against a `&str` expectation and [`gated_range_compare`]'s `f64`
    /// read against an `f64` expectation share one body.
    fn gated_compare<T, U>(
        is_password: PropertyOutcome,
        expected: U,
        mut read: impl FnMut() -> Result<T, AdapterError>,
    ) -> Result<Option<bool>, AdapterError>
    where
        T: PartialEq<U>,
    {
        if withholds_value_read(&is_password) {
            return Ok(None);
        }
        let observed = read()?;
        Ok(Some(observed == expected))
    }

    /// Shared secure-field gate for string value verification (reusable by Select).
    pub(crate) fn gated_value_compare(
        is_password: PropertyOutcome,
        expected: &str,
        read: impl FnMut() -> Result<String, AdapterError>,
    ) -> Result<Option<bool>, AdapterError> {
        gated_compare(is_password, expected, read)
    }

    /// Shared secure-field gate for numeric range verification.
    pub(crate) fn gated_range_compare(
        is_password: PropertyOutcome,
        expected: f64,
        read: impl FnMut() -> Result<f64, AdapterError>,
    ) -> Result<Option<bool>, AdapterError> {
        gated_compare(is_password, expected, read)
    }

    fn withholds_value_read(is_password: &PropertyOutcome) -> bool {
        ElementProperties::from_reads(vec![(TreeProperty::IsPassword, is_password.clone())])
            .is_secure()
    }

    fn read_failed(api: &str, error: &uiautomation::Error) -> AdapterError {
        AdapterError::new(
            ErrorCode::ActionFailed,
            format!("{api} could not re-read the control value after delivery"),
        )
        .with_platform_detail(format!("{api}: {error}"))
        .with_disposition(DeliverySemantics::delivered_unverified())
    }

    fn attach_value_chars(error: AdapterError, value: &str) -> AdapterError {
        error.with_details(serde_json::json!({
            "value_chars": value.chars().count(),
        }))
    }
}

#[cfg(not(target_os = "windows"))]
mod imp {
    use super::{ActionStep, AdapterError, Deadline, InteractionPolicy, UIAElement};
    use crate::tree::properties::property_outcome::PropertyOutcome;

    pub(crate) fn set_value_steps(
        _element: &UIAElement,
        _value: &str,
        _policy: InteractionPolicy,
        _deadline: Deadline,
    ) -> Result<Vec<ActionStep>, AdapterError> {
        Err(AdapterError::not_supported("SetValue"))
    }

    pub(crate) fn clear_steps(
        _element: &UIAElement,
        _policy: InteractionPolicy,
        _deadline: Deadline,
    ) -> Result<Vec<ActionStep>, AdapterError> {
        Err(AdapterError::not_supported("Clear"))
    }

    pub(crate) fn gated_pattern_value_equals(
        _element: &UIAElement,
        _expected: &str,
    ) -> Result<Option<bool>, AdapterError> {
        Err(AdapterError::not_supported("gated_pattern_value_equals"))
    }

    pub(crate) fn gated_value_compare(
        _is_password: PropertyOutcome,
        _expected: &str,
        _read: impl FnMut() -> Result<String, AdapterError>,
    ) -> Result<Option<bool>, AdapterError> {
        Err(AdapterError::not_supported("gated_value_compare"))
    }
}

pub(crate) use imp::{clear_steps, set_value_steps};

#[allow(unused_imports)]
pub(crate) use imp::{gated_pattern_value_equals, gated_value_compare};

#[cfg(all(test, target_os = "windows"))]
pub(crate) use imp::{parse_finite_f64, set_value_judged_for};

#[cfg(all(test, target_os = "windows"))]
#[path = "value_write_tests.rs"]
mod tests;

#[cfg(all(test, target_os = "windows"))]
#[path = "value_write_gate_tests.rs"]
mod gate_tests;
