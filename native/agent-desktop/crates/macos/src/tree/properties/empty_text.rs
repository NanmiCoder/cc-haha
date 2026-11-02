#[cfg(target_os = "macos")]
pub(crate) fn eligible(role: Option<&str>, subrole: Option<&str>) -> bool {
    matches!(role, Some("AXTextField" | "AXTextArea")) && subrole != Some("AXSecureTextField")
}

#[cfg(target_os = "macos")]
pub(crate) fn read(
    element: &crate::tree::AXElement,
    deadline: impl super::ax_ipc::AxDeadline,
) -> Result<Option<String>, i32> {
    use core_foundation::{
        base::{CFType, TCFType},
        string::CFString,
    };
    let attribute = CFString::new("AXNumberOfCharacters");
    let (error, value) =
        super::ax_ipc::copy_attribute_value(element, attribute.as_concrete_TypeRef(), deadline);
    let owned = (!value.is_null()).then(|| unsafe { CFType::wrap_under_create_rule(value) });
    decode(error, owned.as_ref())
}

#[cfg(target_os = "macos")]
fn decode(
    error: i32,
    value: Option<&core_foundation::base::CFType>,
) -> Result<Option<String>, i32> {
    if error != accessibility_sys::kAXErrorSuccess {
        return if matches!(
            error,
            accessibility_sys::kAXErrorNoValue | accessibility_sys::kAXErrorAttributeUnsupported
        ) {
            Ok(None)
        } else {
            Err(error)
        };
    }
    Ok(value
        .filter(|value| zero_count(value))
        .map(|_| String::new()))
}

#[cfg(target_os = "macos")]
fn zero_count(value: &core_foundation::base::CFType) -> bool {
    value
        .downcast::<core_foundation::number::CFNumber>()
        .and_then(|number| number.to_f64())
        == Some(0.0)
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;
    use core_foundation::{base::TCFType, boolean::CFBoolean, number::CFNumber, string::CFString};

    #[test]
    fn only_nonsecure_text_with_numeric_zero_can_supply_empty_evidence() {
        assert!(eligible(Some("AXTextField"), Some("AXSearchField")));
        assert!(eligible(Some("AXTextArea"), None));
        for (role, subrole) in [
            (None, None),
            (Some("AXButton"), None),
            (Some("AXSecureTextField"), None),
            (Some("AXTextField"), Some("AXSecureTextField")),
        ] {
            assert!(!eligible(role, subrole));
        }
        assert!(zero_count(&CFNumber::from(0_i64).as_CFType()));
        for count in [1.0, -1.0, 0.5, f64::NAN] {
            assert!(!zero_count(&CFNumber::from(count).as_CFType()));
        }
        assert!(!zero_count(&CFString::new("0").as_CFType()));
        assert!(!zero_count(&CFBoolean::false_value().as_CFType()));
    }

    #[test]
    fn missing_or_failed_character_counts_never_prove_empty() {
        use accessibility_sys::*;
        let zero = CFNumber::from(0_i64).as_CFType();
        assert_eq!(
            decode(kAXErrorSuccess, Some(&zero)),
            Ok(Some(String::new()))
        );
        assert_eq!(decode(kAXErrorSuccess, None), Ok(None));
        for error in [kAXErrorNoValue, kAXErrorAttributeUnsupported] {
            assert_eq!(decode(error, Some(&zero)), Ok(None));
        }
        for error in [
            kAXErrorCannotComplete,
            kAXErrorFailure,
            kAXErrorInvalidUIElement,
        ] {
            assert_eq!(decode(error, Some(&zero)), Err(error));
        }
    }
}
