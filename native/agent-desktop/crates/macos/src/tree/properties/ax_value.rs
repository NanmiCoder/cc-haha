#[cfg(target_os = "macos")]
mod imp {
    use crate::tree::AXElement;
    use accessibility_sys::{AXUIElementGetTypeID, AXUIElementRef};
    use core_foundation::base::{CFRetain, CFType, CFTypeRef, TCFType};
    use core_foundation_sys::base::{CFGetTypeID, CFRelease};

    pub(crate) fn created_ax_element(value: CFTypeRef) -> Option<AXElement> {
        if value.is_null() {
            return None;
        }
        if !is_ax_element(value) {
            unsafe { CFRelease(value) };
            return None;
        }
        Some(AXElement(value as AXUIElementRef))
    }

    pub(crate) fn retained_ax_element(value: &CFType) -> Option<AXElement> {
        let value_ref = value.as_concrete_TypeRef();
        if !is_ax_element(value_ref) {
            return None;
        }
        unsafe { CFRetain(value_ref) };
        Some(AXElement(value_ref as AXUIElementRef))
    }

    fn is_ax_element(value: CFTypeRef) -> bool {
        !value.is_null() && unsafe { CFGetTypeID(value) } == unsafe { AXUIElementGetTypeID() }
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use core_foundation::{base::CFRetain, string::CFString};

        #[test]
        fn created_ax_element_rejects_null_without_releasing() {
            assert!(created_ax_element(std::ptr::null()).is_none());
        }

        #[test]
        fn created_ax_element_rejects_created_non_ax_ref() {
            let value = CFString::new("not-ax");
            let retained = unsafe { CFRetain(value.as_CFTypeRef()) };

            assert!(created_ax_element(retained).is_none());
            assert_eq!(value.to_string(), "not-ax");
        }

        #[test]
        fn retained_ax_element_rejects_non_ax_ref() {
            let value = CFString::new("not-ax");
            let cf = unsafe { CFType::wrap_under_get_rule(value.as_CFTypeRef()) };

            assert!(retained_ax_element(&cf).is_none());
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    use crate::tree::AXElement;

    pub(crate) fn created_ax_element(_value: *const std::ffi::c_void) -> Option<AXElement> {
        None
    }

    pub(crate) fn retained_ax_element(_value: &core_foundation::base::CFType) -> Option<AXElement> {
        None
    }
}

#[cfg(target_os = "macos")]
pub(crate) use imp::{created_ax_element, retained_ax_element};

#[cfg(not(target_os = "macos"))]
pub(crate) use imp::{created_ax_element, retained_ax_element};
