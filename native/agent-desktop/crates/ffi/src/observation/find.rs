use crate::AdAdapter;
use crate::convert::string::optional_adapter_string;
use crate::error::{AdResult, set_last_error};
use crate::ffi_try::trap_panic;
use crate::types::{AdExactWindowInfo, AdFindQuery, AdFindSelectionKind, AdNativeHandle};
use agent_desktop_core::{
    AdapterError, ContainmentPredicate, ErrorCode, IdentityPredicate, LocatorMaterialization,
    LocatorQuery, LocatorResolveRequest, LocatorSelection, ObservationRoot, StatePredicate,
    resolve_query,
};
use std::collections::HashSet;

const DEFAULT_FIND_TIMEOUT_MS: u64 = 5_000;
const MAX_FIND_STATES: usize = 64;
const MAX_CONTAINMENT_DEPTH: usize = 8;

/// Finds and strictly resolves one element within a generation-pinned window.
/// `AdFindQuery.control.selection` must explicitly request first, last, or nth
/// behavior when duplicate matches are acceptable. The returned native handle
/// is adapter-bound and thread-affine; release it with `ad_free_handle` on the
/// resolving thread.
///
/// # Safety
/// All pointers must be valid and `out_handle` must be writable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ad_find_exact(
    adapter: *const AdAdapter,
    win: *const AdExactWindowInfo,
    query: *const AdFindQuery,
    out_handle: *mut AdNativeHandle,
) -> AdResult {
    trap_panic(|| unsafe {
        crate::pointer_guard::guard_non_null!(out_handle, c"out_handle is null");
        (*out_handle).ptr = std::ptr::null();
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
        find_in_window(adapter, &window, &*query, out_handle)
    })
}

unsafe fn find_in_window(
    adapter: *const AdAdapter,
    window: &agent_desktop_core::WindowInfo,
    query: &AdFindQuery,
    out_handle: *mut AdNativeHandle,
) -> AdResult {
    let (locator, request) = match unsafe { decode_query(query) } {
        Ok(decoded) => decoded,
        Err(error) => {
            set_last_error(&error);
            return AdResult::ErrInvalidArgs;
        }
    };
    let adapter_id = adapter.addr();
    let adapter = crate::adapter::acquire_adapter!(adapter);
    let resolution = match resolve_query(
        adapter.inner.as_ref(),
        &locator,
        ObservationRoot::Window(window),
        &request,
    ) {
        Ok(resolution) => resolution,
        Err(e) => {
            set_last_error(&crate::commands::app_error_to_adapter(e));
            return crate::error::last_error_code();
        }
    };
    let selected = if request.selection == LocatorSelection::Strict {
        match agent_desktop_core::require_unique(resolution) {
            Ok(selected) => selected,
            Err(error) => {
                set_last_error(&crate::commands::app_error_to_adapter(error));
                return crate::error::last_error_code();
            }
        }
    } else {
        if !resolution.meta.selection_complete {
            set_last_error(
                &AdapterError::timeout("Locator traversal could not prove the selected result")
                    .with_details(serde_json::json!({
                        "kind": "locator_incomplete",
                        "observed_matches": resolution.meta.total_matches,
                        "query_stats": resolution.stats,
                    })),
            );
            return AdResult::ErrTimeout;
        }
        let Some(selected) = resolution.matches.into_iter().next() else {
            set_last_error(&AdapterError::new(
                ErrorCode::ElementNotFound,
                "Locator query matched no elements",
            ));
            return AdResult::ErrElementNotFound;
        };
        selected
    };
    let entry = selected.into_entry();
    let Some(process_instance) = entry.process.process_instance.clone() else {
        set_last_error(&AdapterError::new(
            ErrorCode::InvalidArgs,
            "resolved element has no process-generation identity",
        ));
        return AdResult::ErrInvalidArgs;
    };
    let process = agent_desktop_core::ProcessIdentity::new(entry.process.pid, process_instance);
    match adapter
        .inner
        .resolve_element_strict(&entry, request.deadline)
    {
        Ok(handle) => {
            match crate::actions::native_handle::into_ffi_handle(adapter_id, handle, process) {
                Ok(token) => {
                    unsafe { (*out_handle).ptr = token };
                    AdResult::Ok
                }
                Err(error) => {
                    set_last_error(&error);
                    crate::error::last_error_code()
                }
            }
        }
        Err(e) => {
            set_last_error(&e);
            crate::error::last_error_code()
        }
    }
}

pub(crate) unsafe fn decode_query(
    query: &AdFindQuery,
) -> Result<(LocatorQuery, LocatorResolveRequest), AdapterError> {
    let timeout_ms = if query.control.timeout_ms == 0 {
        DEFAULT_FIND_TIMEOUT_MS
    } else {
        query.control.timeout_ms
    };
    let deadline = agent_desktop_core::Deadline::after(timeout_ms)?;
    let selection = match AdFindSelectionKind::from_c(query.control.selection.kind) {
        Some(AdFindSelectionKind::Strict) => LocatorSelection::Strict,
        Some(AdFindSelectionKind::First) => LocatorSelection::First,
        Some(AdFindSelectionKind::Last) => LocatorSelection::Last,
        Some(AdFindSelectionKind::Nth) => LocatorSelection::Nth(query.control.selection.nth),
        None => {
            return Err(AdapterError::new(
                ErrorCode::InvalidArgs,
                "Invalid find selection kind",
            ));
        }
    };
    let mut ancestors = HashSet::new();
    let locator = unsafe { decode_locator(query, 0, &mut ancestors)? };
    Ok((
        locator,
        LocatorResolveRequest {
            selection,
            deadline,
            max_raw_depth: 50,
            surface: None,
            materialization: LocatorMaterialization::None,
        },
    ))
}

unsafe fn decode_locator(
    query: &AdFindQuery,
    depth: usize,
    ancestors: &mut HashSet<usize>,
) -> Result<LocatorQuery, AdapterError> {
    if query.control.version != crate::types::find_query::AD_FIND_QUERY_VERSION {
        return Err(AdapterError::new(
            ErrorCode::InvalidArgs,
            "Unsupported find query version",
        ));
    }
    if depth > MAX_CONTAINMENT_DEPTH {
        return Err(AdapterError::new(
            ErrorCode::InvalidArgs,
            "Find containment exceeds maximum depth",
        ));
    }
    let address = std::ptr::from_ref(query).addr();
    if !ancestors.insert(address) {
        return Err(AdapterError::new(
            ErrorCode::InvalidArgs,
            "Find containment contains a pointer cycle",
        ));
    }
    let result = unsafe { decode_locator_fields(query, depth, ancestors) };
    ancestors.remove(&address);
    result
}

unsafe fn decode_locator_fields(
    query: &AdFindQuery,
    depth: usize,
    ancestors: &mut HashSet<usize>,
) -> Result<LocatorQuery, AdapterError> {
    let filter = &query.filter;
    let states = unsafe { decode_states(filter.states.items, filter.states.count)? };
    let has = unsafe { decode_containment(filter.has, depth, ancestors)? };
    let has_not = unsafe { decode_containment(filter.has_not, depth, ancestors)? };
    Ok(LocatorQuery {
        identity: IdentityPredicate {
            role: optional_adapter_string(filter.identity.role, "filter.identity.role")?,
            name: optional_adapter_string(filter.identity.name, "filter.identity.name")?,
            description: optional_adapter_string(
                filter.identity.description,
                "filter.identity.description",
            )?,
            native_id: optional_adapter_string(
                filter.identity.native_id,
                "filter.identity.native_id",
            )?,
            value: optional_adapter_string(filter.identity.value, "filter.identity.value")?,
        },
        has_text: optional_adapter_string(filter.has_text, "filter.has_text")?,
        exact: filter.exact,
        states,
        containment: ContainmentPredicate { has, has_not },
    })
}

unsafe fn decode_containment(
    nested: *const AdFindQuery,
    depth: usize,
    ancestors: &mut HashSet<usize>,
) -> Result<Option<Box<LocatorQuery>>, AdapterError> {
    if nested.is_null() {
        return Ok(None);
    }
    unsafe { decode_locator(&*nested, depth + 1, ancestors) }
        .map(Box::new)
        .map(Some)
}

unsafe fn decode_states(
    items: *const crate::types::AdFindStatePredicate,
    count: usize,
) -> Result<Vec<StatePredicate>, AdapterError> {
    if count > MAX_FIND_STATES {
        return Err(AdapterError::new(
            ErrorCode::InvalidArgs,
            "Find state predicate count exceeds maximum",
        ));
    }
    if count == 0 {
        return Ok(Vec::new());
    }
    if items.is_null() {
        return Err(AdapterError::new(
            ErrorCode::InvalidArgs,
            "Find states pointer is null while count is nonzero",
        ));
    }
    unsafe { std::slice::from_raw_parts(items, count) }
        .iter()
        .enumerate()
        .map(|(index, state)| {
            let expected = match state.expected {
                -1 => None,
                0 => Some(false),
                1 => Some(true),
                _ => {
                    return Err(AdapterError::new(
                        ErrorCode::InvalidArgs,
                        format!("filter.states[{index}].expected must be -1, 0, or 1"),
                    ));
                }
            };
            Ok(StatePredicate {
                token: crate::convert::string::required_adapter_string(
                    state.token,
                    &format!("filter.states[{index}].token"),
                )?,
                expected,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::AdFindStatePredicate;
    use std::ffi::CString;

    fn query() -> AdFindQuery {
        let mut query = unsafe { std::mem::zeroed::<AdFindQuery>() };
        query.control.version = crate::types::find_query::AD_FIND_QUERY_VERSION;
        query
    }

    #[test]
    fn zeroed_selection_is_strict_and_timeout_is_bounded_default() {
        let decoded = unsafe { decode_query(&query()) }.unwrap();
        assert_eq!(decoded.1.selection, LocatorSelection::Strict);
        assert_eq!(decoded.1.deadline.timeout_ms(), DEFAULT_FIND_TIMEOUT_MS);
    }

    #[test]
    fn explicit_nth_selection_is_preserved() {
        let mut query = query();
        query.control.selection.kind = AdFindSelectionKind::Nth as i32;
        query.control.selection.nth = 7;
        let decoded = unsafe { decode_query(&query) }.unwrap();
        assert_eq!(decoded.1.selection, LocatorSelection::Nth(7));
    }

    #[test]
    fn invalid_version_and_state_encoding_fail_closed() {
        let mut invalid_version = query();
        invalid_version.control.version = u32::MAX;
        assert!(unsafe { decode_query(&invalid_version) }.is_err());

        let token = CString::new("focused").unwrap();
        let state = AdFindStatePredicate {
            token: token.as_ptr(),
            expected: 2,
        };
        let mut invalid_state = query();
        invalid_state.filter.states.items = &state;
        invalid_state.filter.states.count = 1;
        assert!(unsafe { decode_query(&invalid_state) }.is_err());
    }

    #[test]
    fn containment_pointer_cycles_fail_closed() {
        let mut query = query();
        query.filter.has = std::ptr::from_ref(&query);
        assert!(unsafe { decode_query(&query) }.is_err());
    }
}

#[cfg(test)]
#[path = "find_abi_tests.rs"]
mod abi_tests;
