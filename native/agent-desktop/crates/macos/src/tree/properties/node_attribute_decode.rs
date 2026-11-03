#[cfg(target_os = "macos")]
mod imp {
    use accessibility_sys::{
        AXValueGetType, AXValueGetTypeID, AXValueGetValue, kAXValueTypeAXError,
        kAXValueTypeCGPoint, kAXValueTypeCGSize,
    };
    use core_foundation::{
        base::{CFType, TCFType},
        boolean::CFBoolean,
        number::CFNumber,
        string::CFString,
    };
    use core_foundation_sys::base::{CFGetTypeID, CFNullGetTypeID};
    use core_foundation_sys::number::{
        CFNumberGetType, CFNumberIsFloatType, kCFNumberFloat32Type, kCFNumberFloatType,
    };
    use core_graphics::geometry::{CGPoint, CGSize};

    pub(crate) fn is_null(item: &CFType) -> bool {
        unsafe { CFGetTypeID(item.as_CFTypeRef()) == CFNullGetTypeID() }
    }

    pub(crate) fn slot_error(item: &CFType) -> Option<i32> {
        let value = item.as_CFTypeRef();
        if unsafe { CFGetTypeID(value) } != unsafe { AXValueGetTypeID() }
            || unsafe { AXValueGetType(value as _) } != kAXValueTypeAXError
        {
            return None;
        }
        let mut error = 0_i32;
        unsafe {
            AXValueGetValue(
                value as _,
                kAXValueTypeAXError,
                &mut error as *mut _ as *mut std::ffi::c_void,
            )
        }
        .then_some(error)
    }

    pub(crate) fn text(
        index: usize,
        item: &CFType,
        usage: &mut crate::tree::observation_usage::ObservationUsage,
    ) -> Option<crate::tree::properties::bounded_string::BoundedString> {
        if let Some(value) = item.downcast::<CFString>() {
            return crate::tree::properties::bounded_string::BoundedString::from_cf(&value, usage)
                .ok();
        }
        let value = match index {
            3 => scalar_text(item),
            4..=12 => boolean_text(item),
            _ => None,
        }?;
        Some(crate::tree::properties::bounded_string::BoundedString::from_owned(value, usage))
    }

    fn scalar_text(item: &CFType) -> Option<String> {
        if let Some(value) = item.downcast::<CFBoolean>() {
            return Some(bool::from(value).to_string());
        }
        let number = item.downcast::<CFNumber>()?;
        number_text(&number)
    }

    fn boolean_text(item: &CFType) -> Option<String> {
        if let Some(value) = item.downcast::<CFBoolean>() {
            return Some(bool::from(value).to_string());
        }
        item.downcast::<CFNumber>()?
            .to_i64()
            .map(|value| (value != 0).to_string())
    }

    pub(crate) fn number_text(number: &CFNumber) -> Option<String> {
        let number_ref = number.as_concrete_TypeRef();
        if unsafe { CFNumberIsFloatType(number_ref) } == 0 {
            return number.to_i64().map(|value| value.to_string());
        }
        let number_type = unsafe { CFNumberGetType(number_ref) };
        if number_type == kCFNumberFloat32Type || number_type == kCFNumberFloatType {
            number.to_f32().map(|value| value.to_string())
        } else {
            number.to_f64().map(|value| value.to_string())
        }
    }

    pub(crate) fn is_number(item: &CFType) -> bool {
        item.downcast::<CFNumber>().is_some()
    }

    pub(crate) fn point(item: &CFType) -> Option<CGPoint> {
        let mut point = CGPoint::new(0.0, 0.0);
        unsafe {
            AXValueGetValue(
                item.as_CFTypeRef() as _,
                kAXValueTypeCGPoint,
                &mut point as *mut _ as *mut std::ffi::c_void,
            )
        }
        .then_some(point)
    }

    pub(crate) fn size(item: &CFType) -> Option<CGSize> {
        let mut size = CGSize::new(0.0, 0.0);
        unsafe {
            AXValueGetValue(
                item.as_CFTypeRef() as _,
                kAXValueTypeCGSize,
                &mut size as *mut _ as *mut std::ffi::c_void,
            )
        }
        .then_some(size)
    }
}

#[cfg(target_os = "macos")]
pub(crate) use imp::{is_null, is_number, number_text, point, size, slot_error, text};

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;
    use accessibility_sys::{AXValueCreate, kAXErrorCannotComplete, kAXValueTypeAXError};
    use core_foundation::{
        base::{CFType, TCFType},
        number::CFNumber,
    };

    fn number_item(number: &CFNumber) -> CFType {
        unsafe { CFType::wrap_under_get_rule(number.as_CFTypeRef()) }
    }

    fn decode_number_at(index: usize, number: &CFNumber) -> String {
        let item = number_item(number);
        let mut usage = crate::tree::observation_usage::ObservationUsage::new(
            agent_desktop_core::ObservationBudget::default(),
        );
        text(index, &item, &mut usage)
            .expect("CFNumber must decode")
            .value
    }

    #[test]
    fn ax_error_slots_decode_without_becoming_empty_values() {
        let error = kAXErrorCannotComplete;
        let value = unsafe {
            AXValueCreate(
                kAXValueTypeAXError,
                &error as *const _ as *const std::ffi::c_void,
            )
        };
        let value = unsafe { CFType::wrap_under_create_rule(value as _) };

        assert_eq!(slot_error(&value), Some(kAXErrorCannotComplete));
    }

    #[test]
    fn cf_null_slots_remain_authoritatively_absent() {
        let value = unsafe { CFType::wrap_under_get_rule(core_foundation_sys::base::kCFNull as _) };

        assert!(is_null(&value));
        assert_eq!(slot_error(&value), None);
    }

    #[test]
    fn fractional_numbers_keep_shortest_round_trip_text() {
        let first = decode_number_at(3, &CFNumber::from(1.001_f64));
        let second = decode_number_at(3, &CFNumber::from(1.002_f64));

        assert_eq!(first, "1.001");
        assert_eq!(second, "1.002");
        assert_ne!(first, second);
    }

    #[test]
    fn large_integers_remain_exact() {
        assert_eq!(
            decode_number_at(3, &CFNumber::from(i64::MAX)),
            i64::MAX.to_string()
        );
    }

    #[test]
    fn catalyst_numeric_booleans_decode_as_state_values() {
        assert_eq!(decode_number_at(4, &CFNumber::from(0_i32)), "false");
        assert_eq!(decode_number_at(4, &CFNumber::from(1_i32)), "true");
    }

    #[test]
    fn numeric_label_values_are_not_mistaken_for_text() {
        let number = CFNumber::from(0_f32);
        let item = number_item(&number);
        let mut usage = crate::tree::observation_usage::ObservationUsage::new(
            agent_desktop_core::ObservationBudget::default(),
        );

        assert!(is_number(&item));
        assert!(text(15, &item, &mut usage).is_none());
    }
}
