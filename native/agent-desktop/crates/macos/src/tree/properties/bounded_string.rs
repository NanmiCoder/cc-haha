use crate::tree::observation_usage::ObservationUsage;

pub(crate) struct BoundedString {
    pub(crate) value: String,
    pub(crate) complete: bool,
}

impl BoundedString {
    #[cfg(target_os = "macos")]
    pub(crate) fn from_cf(
        value: &core_foundation::string::CFString,
        usage: &mut ObservationUsage,
    ) -> Result<Self, ()> {
        use core_foundation::base::TCFType;
        use core_foundation_sys::{
            base::{CFIndex, CFRange},
            string::{CFStringGetBytes, CFStringGetLength, kCFStringEncodingUTF8},
        };

        let value_ref = value.as_concrete_TypeRef();
        let length = unsafe { CFStringGetLength(value_ref) };
        let capacity = usage.string_capacity();
        let allocation = utf8_allocation_size(length, capacity)?;
        let mut bytes = vec![0_u8; allocation];
        let mut used: CFIndex = 0;
        let converted = unsafe {
            CFStringGetBytes(
                value_ref,
                CFRange::init(0, length),
                kCFStringEncodingUTF8,
                0,
                false.into(),
                bytes.as_mut_ptr(),
                CFIndex::try_from(allocation).map_err(|_| ())?,
                &mut used,
            )
        };
        let used = usize::try_from(used).map_err(|_| ())?;
        bytes.truncate(used);
        let value = String::from_utf8(bytes).map_err(|_| ())?;
        usage.claim_text(used);
        Ok(Self {
            value,
            complete: converted == length,
        })
    }

    pub(crate) fn from_owned(mut value: String, usage: &mut ObservationUsage) -> Self {
        let capacity = usage.string_capacity();
        let complete = value.len() <= capacity;
        if !complete {
            let mut end = capacity.min(value.len());
            while !value.is_char_boundary(end) {
                end = end.saturating_sub(1);
            }
            value.truncate(end);
        }
        usage.claim_text(value.len());
        Self { value, complete }
    }
}

#[cfg(target_os = "macos")]
fn utf8_allocation_size(
    length: core_foundation_sys::base::CFIndex,
    capacity: usize,
) -> Result<usize, ()> {
    let maximum = unsafe {
        core_foundation_sys::string::CFStringGetMaximumSizeForEncoding(
            length,
            core_foundation_sys::string::kCFStringEncodingUTF8,
        )
    };
    Ok(capacity.min(usize::try_from(maximum).map_err(|_| ())?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use agent_desktop_core::ObservationBudget;

    #[test]
    fn owned_text_truncates_only_at_utf8_boundaries() {
        let mut usage = ObservationUsage::new(ObservationBudget {
            max_field_bytes: 4,
            max_text_bytes: 4,
            ..ObservationBudget::default()
        });

        let read = BoundedString::from_owned("a🙂z".into(), &mut usage);

        assert_eq!(read.value, "a");
        assert!(!read.complete);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn short_cf_strings_do_not_allocate_the_full_field_budget() {
        let allocation = utf8_allocation_size(4, 64 * 1024).unwrap();

        assert!(allocation <= 12);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn exhausted_text_budget_never_reports_a_complete_cf_read() {
        let value = core_foundation::string::CFString::new("content");
        let mut usage = ObservationUsage::new(ObservationBudget {
            max_field_bytes: 0,
            max_text_bytes: 0,
            ..ObservationBudget::default()
        });

        let read = BoundedString::from_cf(&value, &mut usage).unwrap();

        assert!(read.value.is_empty());
        assert!(!read.complete);
    }
}
