#[cfg(target_os = "macos")]
mod imp {
    use crate::tree::{AXElement, properties::bounded_string::BoundedString};
    use accessibility_sys::{kAXErrorSuccess, kAXValueAttribute};
    use core_foundation::{
        base::{CFType, CFTypeRef, TCFType},
        boolean::CFBoolean,
        number::CFNumber,
        string::CFString,
    };

    const MALFORMED_AX_VALUE: i32 = i32::MIN;
    const TEXT_TRUNCATED: i32 = i32::MIN + 1;

    pub(crate) fn copy_string_attr_result(
        el: &AXElement,
        attr: &str,
        deadline: impl crate::tree::properties::ax_ipc::AxDeadline,
    ) -> Result<Option<String>, i32> {
        let mut usage = crate::tree::observation_usage::ObservationUsage::new(
            agent_desktop_core::ObservationBudget::default(),
        );
        match copy_string_attr_bounded_result(el, attr, deadline, &mut usage)? {
            Some(value) if value.complete => Ok(Some(value.value)),
            Some(_) => Err(TEXT_TRUNCATED),
            None => Ok(None),
        }
    }

    pub(crate) fn copy_string_attr_bounded_result(
        el: &AXElement,
        attr: &str,
        deadline: impl crate::tree::properties::ax_ipc::AxDeadline,
        usage: &mut crate::tree::observation_usage::ObservationUsage,
    ) -> Result<Option<BoundedString>, i32> {
        let attribute = CFString::new(attr);
        let (error, value) = crate::tree::properties::ax_ipc::copy_attribute_value(
            el,
            attribute.as_concrete_TypeRef(),
            deadline,
        );
        if error != kAXErrorSuccess {
            release_if_present(value);
            return if is_absent_error(error) {
                Ok(None)
            } else {
                Err(error)
            };
        }
        if value.is_null() {
            return Ok(None);
        }
        let value = unsafe { CFType::wrap_under_create_rule(value) }
            .downcast::<CFString>()
            .ok_or(MALFORMED_AX_VALUE)?;
        BoundedString::from_cf(&value, usage)
            .map(Some)
            .map_err(|_| MALFORMED_AX_VALUE)
    }

    pub(crate) fn copy_value_typed(
        el: &AXElement,
        deadline: impl crate::tree::properties::ax_ipc::AxDeadline,
    ) -> Option<String> {
        copy_value_typed_result(el, deadline).ok().flatten()
    }

    pub(crate) fn copy_value_typed_result(
        el: &AXElement,
        deadline: impl crate::tree::properties::ax_ipc::AxDeadline,
    ) -> Result<Option<String>, i32> {
        let mut usage = crate::tree::observation_usage::ObservationUsage::new(
            agent_desktop_core::ObservationBudget::default(),
        );
        match copy_value_typed_bounded_result(el, deadline, &mut usage)? {
            Some(value) if value.complete => Ok(Some(value.value)),
            Some(_) => Err(TEXT_TRUNCATED),
            None => Ok(None),
        }
    }

    pub(crate) fn copy_value_typed_bounded_result(
        el: &AXElement,
        deadline: impl crate::tree::properties::ax_ipc::AxDeadline,
        usage: &mut crate::tree::observation_usage::ObservationUsage,
    ) -> Result<Option<BoundedString>, i32> {
        let attribute = CFString::new(kAXValueAttribute);
        let (error, value) = crate::tree::properties::ax_ipc::copy_attribute_value(
            el,
            attribute.as_concrete_TypeRef(),
            deadline,
        );
        if error != kAXErrorSuccess {
            release_if_present(value);
            if error == accessibility_sys::kAXErrorNoValue {
                let role = copy_string_attr_result(el, "AXRole", deadline)?;
                let subrole = copy_string_attr_result(el, "AXSubrole", deadline)?;
                if crate::tree::properties::empty_text::eligible(
                    role.as_deref(),
                    subrole.as_deref(),
                ) {
                    return crate::tree::properties::empty_text::read(el, deadline)
                        .map(|value| value.map(|text| BoundedString::from_owned(text, usage)));
                }
            }
            return if is_absent_error(error) {
                Ok(None)
            } else {
                Err(error)
            };
        }
        if value.is_null() {
            return Ok(None);
        }
        let value = unsafe { CFType::wrap_under_create_rule(value) };
        if let Some(text) = value.downcast::<CFString>() {
            return BoundedString::from_cf(&text, usage)
                .map(Some)
                .map_err(|_| MALFORMED_AX_VALUE);
        }
        if let Some(boolean) = value.downcast::<CFBoolean>() {
            return Ok(Some(BoundedString::from_owned(
                bool::from(boolean).to_string(),
                usage,
            )));
        }
        if let Some(number) = value.downcast::<CFNumber>() {
            let text = crate::tree::properties::node_attribute_decode::number_text(&number);
            return Ok(text.map(|text| BoundedString::from_owned(text, usage)));
        }
        Err(MALFORMED_AX_VALUE)
    }

    fn is_absent_error(error: i32) -> bool {
        crate::tree::properties::ax_absence::is_absent_attribute_error(error)
    }

    fn release_if_present(value: CFTypeRef) {
        if !value.is_null() {
            drop(unsafe { CFType::wrap_under_create_rule(value) });
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    use crate::tree::{AXElement, properties::bounded_string::BoundedString};

    pub(crate) fn copy_string_attr_result(
        _el: &AXElement,
        _attr: &str,
        _deadline: impl crate::tree::properties::ax_ipc::AxDeadline,
    ) -> Result<Option<String>, i32> {
        Ok(None)
    }

    pub(crate) fn copy_string_attr_bounded_result(
        _el: &AXElement,
        _attr: &str,
        _deadline: impl crate::tree::properties::ax_ipc::AxDeadline,
        _usage: &mut crate::tree::observation_usage::ObservationUsage,
    ) -> Result<Option<BoundedString>, i32> {
        Ok(None)
    }

    pub(crate) fn copy_value_typed(
        _el: &AXElement,
        _deadline: impl crate::tree::properties::ax_ipc::AxDeadline,
    ) -> Option<String> {
        None
    }

    pub(crate) fn copy_value_typed_result(
        _el: &AXElement,
        _deadline: impl crate::tree::properties::ax_ipc::AxDeadline,
    ) -> Result<Option<String>, i32> {
        Ok(None)
    }

    pub(crate) fn copy_value_typed_bounded_result(
        _el: &AXElement,
        _deadline: impl crate::tree::properties::ax_ipc::AxDeadline,
        _usage: &mut crate::tree::observation_usage::ObservationUsage,
    ) -> Result<Option<BoundedString>, i32> {
        Ok(None)
    }
}

pub(crate) use imp::{
    copy_string_attr_bounded_result, copy_string_attr_result, copy_value_typed,
    copy_value_typed_bounded_result, copy_value_typed_result,
};
