pub(crate) struct NativeRead<T> {
    pub(crate) value: Option<T>,
    pub(crate) error: Option<i32>,
}

impl<T> NativeRead<T> {
    fn success(value: T) -> Self {
        Self {
            value: Some(value),
            error: None,
        }
    }

    fn failure(error: i32) -> Self {
        Self {
            value: None,
            error: Some(error),
        }
    }
}

#[cfg(target_os = "macos")]
fn read_with_recovery<T>(
    deadline: std::time::Instant,
    mut read: impl FnMut() -> NativeRead<T>,
) -> NativeRead<T> {
    crate::tree::read_recovery::read(deadline, || {
        let result = read();
        match result.error {
            Some(error) => Err(error),
            None => Ok(result),
        }
    })
    .unwrap_or_else(NativeRead::failure)
}

#[cfg(target_os = "macos")]
mod imp {
    use super::NativeRead;
    use crate::{tree::AXElement, tree::properties::cf_type::created_cf_array};
    use accessibility_sys::kAXErrorSuccess;
    use core_foundation::{
        base::{CFEqual, CFTypeRef, TCFType},
        string::CFString,
    };

    pub(crate) fn is_attr_settable_with_status(
        el: &AXElement,
        attr: &str,
        deadline: std::time::Instant,
    ) -> NativeRead<bool> {
        let cf_attr = CFString::new(attr);
        super::read_with_recovery(deadline, || {
            let (err, settable) = crate::tree::properties::ax_ipc::is_attribute_settable(
                el,
                cf_attr.as_concrete_TypeRef(),
                deadline,
            );
            if err == kAXErrorSuccess {
                NativeRead::success(settable)
            } else {
                NativeRead::failure(err)
            }
        })
    }

    pub(crate) fn copy_action_names_with_status(
        el: &AXElement,
        deadline: std::time::Instant,
        usage: &mut crate::tree::observation_usage::ObservationUsage,
    ) -> NativeRead<Vec<String>> {
        super::read_with_recovery(deadline, || copy_action_names_once(el, deadline, usage))
    }

    fn copy_action_names_once(
        el: &AXElement,
        deadline: std::time::Instant,
        usage: &mut crate::tree::observation_usage::ObservationUsage,
    ) -> NativeRead<Vec<String>> {
        let (err, actions_ref) = crate::tree::properties::ax_ipc::copy_action_names(el, deadline);
        if err != kAXErrorSuccess {
            if !actions_ref.is_null() {
                drop(created_cf_array(actions_ref as _));
            }
            return NativeRead::failure(err);
        }
        if actions_ref.is_null() {
            return NativeRead::failure(err);
        }

        let Some(actions) = created_cf_array(actions_ref as _) else {
            return NativeRead::failure(i32::MIN);
        };
        if actions.len() > 256 {
            return NativeRead::failure(i32::MIN + 1);
        }
        let mut result = Vec::with_capacity(actions.len() as usize);
        for i in 0..actions.len() {
            if let Some(name) = actions.get(i).and_then(|v| v.downcast::<CFString>()) {
                match crate::tree::properties::bounded_string::BoundedString::from_cf(&name, usage)
                {
                    Ok(name) if name.complete => result.push(name.value),
                    _ => return NativeRead::failure(i32::MIN + 2),
                }
            } else {
                return NativeRead::failure(i32::MIN);
            }
        }
        NativeRead::success(result)
    }

    pub fn same_element(a: &AXElement, b: &AXElement) -> bool {
        unsafe { CFEqual(a.0 as CFTypeRef, b.0 as CFTypeRef) != 0 }
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    use super::NativeRead;
    use crate::tree::AXElement;

    pub(crate) fn is_attr_settable_with_status(
        _el: &AXElement,
        _attr: &str,
        _deadline: std::time::Instant,
    ) -> NativeRead<bool> {
        NativeRead::failure(i32::MIN)
    }

    pub(crate) fn copy_action_names_with_status(
        _el: &AXElement,
        _deadline: std::time::Instant,
        _usage: &mut crate::tree::observation_usage::ObservationUsage,
    ) -> NativeRead<Vec<String>> {
        NativeRead::failure(i32::MIN)
    }

    pub fn same_element(_a: &AXElement, _b: &AXElement) -> bool {
        false
    }
}

pub(crate) use imp::same_element;
pub(crate) use imp::{copy_action_names_with_status, is_attr_settable_with_status};

#[cfg(test)]
mod tests {
    use super::NativeRead;

    #[test]
    fn failed_native_read_never_fabricates_an_empty_value() {
        let strings = NativeRead::<Vec<String>>::failure(-1);
        let flag = NativeRead::<bool>::failure(-1);

        assert!(strings.value.is_none());
        assert!(flag.value.is_none());
        assert_eq!(strings.error, Some(-1));
        assert_eq!(flag.error, Some(-1));
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn capability_read_recovers_only_transient_failures_within_a_fixed_attempt_bound() {
        use accessibility_sys::{
            kAXErrorAPIDisabled, kAXErrorCannotComplete, kAXErrorFailure, kAXErrorInvalidUIElement,
        };
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        let mut reads = 0;
        let recovered = super::read_with_recovery(deadline, || {
            reads += 1;
            if reads < 3 {
                NativeRead::failure(kAXErrorCannotComplete)
            } else {
                NativeRead::success(false)
            }
        });
        assert_eq!(reads, 3);
        assert_eq!(recovered.value, Some(false));
        assert_eq!(recovered.error, None);
        for code in [
            kAXErrorCannotComplete,
            kAXErrorAPIDisabled,
            kAXErrorInvalidUIElement,
            kAXErrorFailure,
        ] {
            let mut reads = 0;
            let result = super::read_with_recovery::<bool>(deadline, || {
                reads += 1;
                NativeRead::failure(code)
            });
            assert_eq!(reads, if code == kAXErrorCannotComplete { 3 } else { 1 });
            assert_eq!(result.error, Some(code));
            assert_eq!(result.value, None);
        }
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn expired_capability_budget_never_calls_native_reader() {
        let result =
            super::read_with_recovery::<bool>(std::time::Instant::now(), || panic!("expired read"));
        assert_eq!(
            result.error,
            Some(accessibility_sys::kAXErrorCannotComplete)
        );
    }
}
