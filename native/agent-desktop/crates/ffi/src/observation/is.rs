use crate::AdAdapter;
use crate::convert::string::required_adapter_string;
use crate::error::{AdResult, set_last_error};
use crate::ffi_try::trap_panic;
use crate::types::{AdExactWindowInfo, AdFindQuery};
use agent_desktop_core::{ObservationRoot, resolve_query};
use std::os::raw::c_char;

enum SupportedProperty {
    Focused,
    Disabled,
    Enabled,
    Selected,
}

impl SupportedProperty {
    fn parse(name: &str) -> Option<Self> {
        match name {
            "focused" => Some(Self::Focused),
            "disabled" => Some(Self::Disabled),
            "enabled" => Some(Self::Enabled),
            "selected" => Some(Self::Selected),
            _ => None,
        }
    }

    fn evaluate(&self, states: &[String]) -> bool {
        let contains = |wanted: &str| {
            states
                .iter()
                .any(|state| state.eq_ignore_ascii_case(wanted))
        };
        match self {
            Self::Focused => contains("focused"),
            Self::Disabled => contains("disabled"),
            Self::Enabled => !contains("disabled"),
            Self::Selected => contains("selected"),
        }
    }
}

/// Checks a boolean state within a generation-pinned exact window.
///
/// # Safety
/// All pointers must be valid and `out` must be writable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ad_is_exact(
    adapter: *const AdAdapter,
    win: *const AdExactWindowInfo,
    query: *const AdFindQuery,
    property: *const c_char,
    out: *mut bool,
) -> AdResult {
    trap_panic(|| unsafe {
        crate::pointer_guard::guard_non_null!(out, c"out is null");
        *out = false;
        crate::pointer_guard::guard_non_null!(adapter, c"adapter is null");
        crate::pointer_guard::guard_non_null!(win, c"win is null");
        crate::pointer_guard::guard_non_null!(query, c"query is null");
        let window = match crate::windows::ad_exact_window_to_core(&*win) {
            Ok(window) => window,
            Err(error) => {
                set_last_error(&error);
                return crate::error::last_error_code();
            }
        };
        is_in_window(adapter, &window, &*query, property, out)
    })
}

unsafe fn is_in_window(
    adapter: *const AdAdapter,
    window: &agent_desktop_core::WindowInfo,
    query: &AdFindQuery,
    property: *const c_char,
    out: *mut bool,
) -> AdResult {
    let (locator, request) = match unsafe { super::find::decode_query(query) } {
        Ok(decoded) => decoded,
        Err(error) => {
            set_last_error(&error);
            return AdResult::ErrInvalidArgs;
        }
    };
    let property_name = match required_adapter_string(property, "property") {
        Ok(property) => property,
        Err(error) => {
            set_last_error(&error);
            return AdResult::ErrInvalidArgs;
        }
    };
    let property = match SupportedProperty::parse(&property_name) {
        Some(property) => property,
        None => {
            let error = agent_desktop_core::AdapterError::new(
                agent_desktop_core::ErrorCode::InvalidArgs,
                "unknown property — expected one of: focused, disabled, enabled, selected",
            );
            set_last_error(&error);
            return AdResult::ErrInvalidArgs;
        }
    };
    let adapter = crate::adapter::acquire_adapter!(adapter);
    let resolution = match resolve_query(
        adapter.inner.as_ref(),
        &locator,
        ObservationRoot::Window(window),
        &request,
    ) {
        Ok(resolution) => resolution,
        Err(error) => {
            set_last_error(&crate::commands::app_error_to_adapter(error));
            return crate::error::last_error_code();
        }
    };
    let selected = if request.selection == agent_desktop_core::LocatorSelection::Strict {
        match agent_desktop_core::require_unique(resolution) {
            Ok(selected) => selected,
            Err(error) => {
                set_last_error(&crate::commands::app_error_to_adapter(error));
                return crate::error::last_error_code();
            }
        }
    } else {
        if !resolution.meta.selection_complete {
            set_last_error(&agent_desktop_core::AdapterError::timeout(
                "Locator traversal could not prove the selected result",
            ));
            return AdResult::ErrTimeout;
        }
        let Some(selected) = resolution.matches.into_iter().next() else {
            set_last_error(&agent_desktop_core::AdapterError::new(
                agent_desktop_core::ErrorCode::ElementNotFound,
                "Locator query matched no elements",
            ));
            return crate::error::last_error_code();
        };
        selected
    };
    let entry = selected.into_entry();
    unsafe { *out = property.evaluate(&entry.capabilities.states) };
    AdResult::Ok
}

#[cfg(test)]
#[path = "is_abi_tests.rs"]
mod abi_tests;

#[cfg(test)]
mod tests {
    use super::SupportedProperty;

    #[test]
    fn properties_evaluate_normalized_states() {
        let states = vec![String::from("focused")];
        assert!(SupportedProperty::Focused.evaluate(&states));
        assert!(!SupportedProperty::Disabled.evaluate(&states));
        assert!(SupportedProperty::Enabled.evaluate(&states));
        assert!(!SupportedProperty::Enabled.evaluate(&[String::from("disabled")]));
    }

    #[test]
    fn selected_property_evaluates_normalized_state() {
        let property = SupportedProperty::parse("selected").expect("selected must be supported");
        assert!(property.evaluate(&[String::from("SeLeCtEd")]));
        assert!(!property.evaluate(&[]));
    }
}
