#[cfg(target_os = "macos")]
mod imp {
    use core_foundation::{
        array::CFArray,
        base::{CFType, CFTypeRef, TCFType},
        dictionary::CFDictionary,
        number::CFNumber,
        string::CFString,
    };
    use core_foundation_sys::{
        array::CFArrayGetTypeID,
        base::{CFGetTypeID, CFRelease},
        dictionary::CFDictionaryGetTypeID,
        number::CFNumberGetTypeID,
        string::CFStringGetTypeID,
    };

    /// Takes ownership of a non-null +1 create-rule reference and releases mismatched values.
    pub(crate) fn created_cf_array(value: CFTypeRef) -> Option<CFArray<CFType>> {
        if value.is_null() {
            return None;
        }
        if !matches_cf_type(value, unsafe { CFArrayGetTypeID() }) {
            unsafe { CFRelease(value) };
            return None;
        }
        Some(unsafe { CFArray::<CFType>::wrap_under_create_rule(value as _) })
    }

    pub(crate) fn borrowed_cf_dictionary(
        value: CFTypeRef,
    ) -> Option<CFDictionary<CFString, CFType>> {
        if matches_cf_type(value, unsafe { CFDictionaryGetTypeID() }) {
            Some(unsafe { CFDictionary::<CFString, CFType>::wrap_under_get_rule(value as _) })
        } else {
            None
        }
    }

    pub(crate) fn borrowed_cf_number(value: CFTypeRef) -> Option<CFNumber> {
        if matches_cf_type(value, unsafe { CFNumberGetTypeID() }) {
            Some(unsafe { CFNumber::wrap_under_get_rule(value as _) })
        } else {
            None
        }
    }

    pub(crate) fn borrowed_cf_string(value: CFTypeRef) -> Option<CFString> {
        if matches_cf_type(value, unsafe { CFStringGetTypeID() }) {
            Some(unsafe { CFString::wrap_under_get_rule(value as _) })
        } else {
            None
        }
    }

    fn matches_cf_type(value: CFTypeRef, expected: core_foundation_sys::base::CFTypeID) -> bool {
        !value.is_null() && unsafe { CFGetTypeID(value) } == expected
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use core_foundation::base::CFRetain;

        #[test]
        fn created_array_rejects_null() {
            assert!(created_cf_array(std::ptr::null()).is_none());
        }

        #[test]
        fn created_array_rejects_created_non_array_ref() {
            let value = CFString::new("not-array");
            let retained = unsafe { CFRetain(value.as_CFTypeRef()) };

            assert!(created_cf_array(retained).is_none());
            assert_eq!(value.to_string(), "not-array");
        }

        #[test]
        fn created_array_wraps_created_array_ref() {
            let value = CFString::new("item");
            let refs = [value.as_concrete_TypeRef()];
            let array = CFArray::from_copyable(&refs);
            let retained = unsafe { CFRetain(array.as_CFTypeRef()) };

            let wrapped = created_cf_array(retained).expect("array should wrap");

            assert_eq!(wrapped.len(), 1);
        }

        #[test]
        fn borrowed_string_rejects_non_string_ref() {
            let number = CFNumber::from(7);

            assert!(borrowed_cf_string(number.as_CFTypeRef()).is_none());
        }

        #[test]
        fn borrowed_dictionary_accepts_dictionary_ref() {
            let key = CFString::new("key");
            let value = CFString::new("value");
            let dict = CFDictionary::from_CFType_pairs(&[(key.as_CFType(), value.as_CFType())]);

            assert!(borrowed_cf_dictionary(dict.as_CFTypeRef()).is_some());
        }

        #[test]
        fn borrowed_dictionary_rejects_non_dictionary_ref() {
            let value = CFString::new("not-dictionary");

            assert!(borrowed_cf_dictionary(value.as_CFTypeRef()).is_none());
        }

        #[test]
        fn borrowed_number_accepts_number_ref() {
            let value = CFNumber::from(7);

            assert_eq!(
                borrowed_cf_number(value.as_CFTypeRef()).and_then(|n| n.to_i64()),
                Some(7)
            );
        }

        #[test]
        fn borrowed_number_rejects_non_number_ref() {
            let value = CFString::new("not-number");

            assert!(borrowed_cf_number(value.as_CFTypeRef()).is_none());
        }
    }
}

#[cfg(target_os = "macos")]
pub(crate) use imp::{
    borrowed_cf_dictionary, borrowed_cf_number, borrowed_cf_string, created_cf_array,
};
