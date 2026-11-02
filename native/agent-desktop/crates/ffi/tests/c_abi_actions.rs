mod common;

use common::{
    AdActionResult, AdActionStep, AdNativeHandle, AdPolicyKind, AdResult,
    ad_adapter_create_with_session, ad_adapter_destroy, ad_execute_action,
    ad_execute_action_with_policy, ad_execute_ref_action_exact_with_policy, ad_free_action_result,
    ad_last_error_message, default_action, default_exact_ref_entry, with_adapter,
};
use std::ffi::{CStr, CString};

#[test]
fn enum_fuzz_invalid_discriminant_rejected() {
    with_adapter(|adapter| unsafe {
        let mut action = default_action();
        action.kind = i32::MAX;
        let handle = AdNativeHandle {
            ptr: std::ptr::dangling::<std::ffi::c_void>(),
        };
        let mut out: AdActionResult = std::mem::zeroed();
        let rc = ad_execute_action(adapter, &handle, &action, &mut out);
        assert_eq!(rc, AdResult::ErrInvalidArgs);
        let message = CStr::from_ptr(ad_last_error_message()).to_string_lossy();
        assert!(
            message.contains("invalid action kind discriminant"),
            "rejection must come from the discriminant check, got: {message}"
        );
    });
}

#[test]
fn invalid_policy_discriminant_rejected_without_ub() {
    with_adapter(|adapter| unsafe {
        let action = default_action();
        let handle = AdNativeHandle {
            ptr: std::ptr::dangling::<std::ffi::c_void>(),
        };
        let mut out: AdActionResult = std::mem::zeroed();
        let rc = ad_execute_action_with_policy(
            adapter,
            &handle,
            &action,
            AdPolicyKind::Headed as i32 + 1,
            &mut out,
        );
        assert_eq!(rc, AdResult::ErrInvalidArgs);
    });
}

#[test]
fn execute_action_rejects_null_handle_ptr() {
    with_adapter(|adapter| unsafe {
        let action = default_action();
        let handle = AdNativeHandle {
            ptr: std::ptr::null(),
        };
        let mut out: AdActionResult = std::mem::zeroed();
        let rc = ad_execute_action(adapter, &handle, &action, &mut out);
        assert_eq!(rc, AdResult::ErrInvalidArgs);
    });
}

#[test]
fn exact_ref_action_without_process_generation_is_rejected() {
    with_adapter(|adapter| unsafe {
        let role = std::ffi::CString::new("button").unwrap();
        let mut entry = default_exact_ref_entry();
        entry.entry.identity.role = role.as_ptr();
        let action = default_action();
        let mut out: AdActionResult = std::mem::zeroed();

        let rc = ad_execute_ref_action_exact_with_policy(
            adapter,
            &entry,
            &action,
            AdPolicyKind::Headless as i32,
            &mut out,
        );

        assert_eq!(rc, AdResult::ErrInvalidArgs);
    });
}

#[test]
fn execute_action_policy_rejects_null_adapter_on_worker_thread() {
    let rc = std::thread::spawn(|| unsafe {
        let action = default_action();
        let handle = AdNativeHandle {
            ptr: std::ptr::null(),
        };
        let mut out: AdActionResult = std::mem::zeroed();
        ad_execute_action_with_policy(
            std::ptr::null(),
            &handle,
            &action,
            AdPolicyKind::Headless as i32,
            &mut out,
        )
    })
    .join()
    .unwrap();

    assert_eq!(rc, AdResult::ErrInvalidArgs);
}

/// Session context must not weaken the exact ref entry's fail-closed identity
/// check.
#[test]
fn session_adapter_keeps_exact_ref_missing_generation_fail_closed() {
    unsafe {
        let session = CString::new("test-session-01").unwrap();
        let adapter = ad_adapter_create_with_session(session.as_ptr());
        assert!(!adapter.is_null());

        let role = CString::new("button").unwrap();
        let mut entry = default_exact_ref_entry();
        entry.entry.identity.role = role.as_ptr();
        let action = default_action();
        let mut out: AdActionResult = std::mem::zeroed();

        let rc = ad_execute_ref_action_exact_with_policy(
            adapter,
            &entry,
            &action,
            AdPolicyKind::Headless as i32,
            &mut out,
        );

        assert_eq!(rc, AdResult::ErrInvalidArgs);
        let message = CStr::from_ptr(ad_last_error_message()).to_string_lossy();
        assert!(
            message.contains("process_instance"),
            "rejection must be the missing process_instance check, got: {message}"
        );

        ad_adapter_destroy(adapter);
    }
}

#[test]
fn free_action_result_never_scans_an_unowned_steps_array() {
    let mut steps = vec![
        AdActionStep {
            label: CString::new("AXScrollToVisible").unwrap().into_raw(),
            outcome: CString::new("attempted").unwrap().into_raw(),
            mechanism: 1,
            has_mechanism: true,
            verified: false,
            has_verified: false,
            _reserved: 0,
        },
        AdActionStep {
            label: CString::new("AXPress").unwrap().into_raw(),
            outcome: CString::new("succeeded").unwrap().into_raw(),
            mechanism: 1,
            has_mechanism: true,
            verified: true,
            has_verified: true,
            _reserved: 0,
        },
        AdActionStep {
            label: std::ptr::null(),
            outcome: std::ptr::null(),
            mechanism: 0,
            has_mechanism: false,
            verified: false,
            has_verified: false,
            _reserved: 0,
        },
    ]
    .into_boxed_slice();
    let steps_ptr = steps.as_mut_ptr();
    let action_ptr = CString::new("click").unwrap().into_raw();
    let mut result = AdActionResult {
        action: action_ptr,
        ref_id: std::ptr::null(),
        post_state: std::ptr::null_mut(),
        steps: steps.as_mut_ptr(),
        step_count: 2,
        details_json: std::ptr::null(),
        disposition: agent_desktop_ffi::AdDeliverySemantics {
            delivery: agent_desktop_ffi::AdDeliveryDisposition::Unknown as i32,
            retry: agent_desktop_ffi::AdRetryDisposition::Unknown as i32,
        },
    };
    std::mem::forget(steps);

    unsafe { ad_free_action_result(&mut result) };

    assert!(result.action.is_null());
    assert!(result.steps.is_null());
    assert_eq!(result.step_count, 0);
    assert!(result.details_json.is_null());

    let mut steps = unsafe { Box::from_raw(std::ptr::slice_from_raw_parts_mut(steps_ptr, 3)) };
    for step in steps.iter_mut().take(2) {
        unsafe {
            drop(CString::from_raw(step.label as *mut _));
            drop(CString::from_raw(step.outcome as *mut _));
        }
    }
    unsafe { drop(CString::from_raw(action_ptr)) };
}
