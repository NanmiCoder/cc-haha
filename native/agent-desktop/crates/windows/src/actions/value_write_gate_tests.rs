use super::imp::gated_value_compare;
use super::{SetValuePlan, set_value_judged_for};
use crate::actions::chain::DeliveryOutcome;
use crate::actions::dispatch::execute_action_impl;
use crate::system::fixture::test_time::deadline;
use crate::tree::automation::automation_client;
use crate::tree::element::UIAElement;
use crate::tree::fixture::fixture_window;
use crate::tree::fixture::{CONTENT_MARKER, LocalFixture, ensure_test_apartment};
use crate::tree::properties::property_outcome::{PropertyOutcome, PropertyValue};
use agent_desktop_core::{
    Action, ActionRequest, ActionStepOutcome, AdapterError, DeliveryDisposition, InteractionLease,
    InteractionPolicy, NativeHandle,
};
use std::cell::Cell;
use uiautomation::types::Handle;

fn lease() -> InteractionLease {
    InteractionLease::guarded(deadline(5_000), ()).expect("lease")
}

fn known_flag(value: bool) -> PropertyOutcome {
    PropertyOutcome::Known(PropertyValue::Flag(value))
}

fn code_lines(source: &str) -> impl Iterator<Item = (usize, &str)> {
    source
        .lines()
        .enumerate()
        .filter(|(_, line)| {
            let trimmed = line.trim_start();
            !(trimmed.starts_with("///") || trimmed.starts_with("//!"))
        })
        .map(|(index, line)| (index + 1, line))
}

#[test]
fn secure_is_password_skips_get_value_and_reports_unobserved() {
    let reads = Cell::new(0u8);
    let verified = gated_value_compare(known_flag(true), "secret-marker-zz", || {
        reads.set(reads.get() + 1);
        Ok("secret-marker-zz".into())
    })
    .expect("gate");
    assert_eq!(verified, None);
    assert_eq!(reads.get(), 0);

    let steps = set_value_judged_for(
        deadline(5_000),
        InteractionPolicy::headless(),
        SetValuePlan {
            value: "secret-marker-zz",
            value_writable: true,
            range_available: false,
        },
        || Ok(DeliveryOutcome::from_observation(None)),
        || Ok(DeliveryOutcome::NotDelivered),
    )
    .expect("secure write");
    assert_eq!(steps[0].verified(), None);
    let result = agent_desktop_core::ActionResult::from_execution(
        &Action::SetValue("secret-marker-zz".into()),
        steps,
    );
    assert_eq!(
        result.disposition().delivery(),
        DeliveryDisposition::DeliveredUnverified
    );
}

#[test]
fn unknown_is_password_withholds_identically() {
    let reads = Cell::new(0u8);
    let verified = gated_value_compare(PropertyOutcome::Unknown, "marker", || {
        reads.set(reads.get() + 1);
        Ok("marker".into())
    })
    .expect("unknown withholds");
    assert_eq!(verified, None);
    assert_eq!(reads.get(), 0);
}

#[test]
fn known_false_is_password_reads_and_compares() {
    let reads = Cell::new(0u8);
    let verified = gated_value_compare(known_flag(false), "abc", || {
        reads.set(reads.get() + 1);
        Ok("abc".into())
    })
    .expect("readable");
    assert_eq!(verified, Some(true));
    assert_eq!(reads.get(), 1);

    let mismatch =
        gated_value_compare(known_flag(false), "abc", || Ok("xyz".into())).expect("mismatch");
    assert_eq!(mismatch, Some(false));
}

#[test]
fn inverted_secure_gate_would_call_get_value() {
    let reads = Cell::new(0u8);
    let _ = gated_value_compare(known_flag(false), "x", || {
        reads.set(reads.get() + 1);
        Ok("x".into())
    });
    assert_eq!(
        reads.get(),
        1,
        "flipping the gate to Known(false) must observe a get_value"
    );
}

#[test]
fn pattern_get_value_lives_only_inside_value_write_gate() {
    let actions_sources = crate::actions::mutation::action_scan_sources();
    let get_value = concat!(".", "get_value(");
    for (name, source) in actions_sources {
        for (number, line) in code_lines(source) {
            if name.ends_with("value_write.rs") {
                continue;
            }
            assert!(
                !line.contains(get_value),
                "{name}:{number} must not call get_value outside the gate: {line}"
            );
        }
    }
    let value_write = include_str!("value_write.rs");
    assert!(
        value_write.contains(get_value),
        "value_write.rs must own the get_value call sites"
    );
    assert!(
        value_write.contains("gated_pattern_value_equals")
            && value_write.contains("gated_pattern_range_equals"),
        "get_value must live inside the gated helpers"
    );
}

#[test]
fn a_planted_get_value_outside_the_gate_is_caught() {
    let get_value = concat!(".", "get_value(");
    let fixture = "let _ = pattern.get_value();";
    assert!(fixture.contains(get_value));
    let offences = code_lines(fixture)
        .filter(|(_, line)| line.contains(get_value))
        .count();
    assert_eq!(
        offences, 1,
        "MUST-CATCH: planted get_value outside the gate must fail the scan"
    );
}

fn control_handle(hwnd: *mut std::ffi::c_void) -> Result<NativeHandle, AdapterError> {
    let client = automation_client()?;
    let element = client
        .element_from_handle(Handle::from(hwnd as isize))
        .map_err(|error| {
            crate::tree::automation::uia_error(&error, "resolve the fixture control")
        })?;
    Ok(UIAElement::from(element).into_native_handle())
}

#[test]
fn live_fixture_set_value_round_trips_when_value_pattern_exists() {
    ensure_test_apartment();
    let fixture = LocalFixture::create().expect("fixture");
    let edit = find_content_edit(fixture.handle());
    assert!(
        !edit.is_null(),
        "fixture must contain an edit control with content marker"
    );
    let handle = match control_handle(edit) {
        Ok(handle) => handle,
        Err(error) => {
            panic!("control_handle must resolve the fixture edit control: {error}")
        }
    };
    let payload = "zzlivevaluezz";
    let result = execute_action_impl(
        &handle,
        ActionRequest::headless(Action::SetValue(payload.into())),
        &lease(),
    )
    .expect("SetValue on the fixture EDIT, which exposes a value provider, must be delivered");
    assert!(
        result.steps.iter().any(|step| {
            matches!(step.outcome, ActionStepOutcome::Succeeded) && step.verified == Some(true)
        }),
        "expected a verified SetValue step: {:?}",
        result.steps
    );
    assert_eq!(window_text(edit), payload);
}

fn find_content_edit(parent: isize) -> *mut std::ffi::c_void {
    use windows_sys::Win32::UI::WindowsAndMessaging::FindWindowExW;
    let class = fixture_window::wide("EDIT");
    let mut after = std::ptr::null_mut();
    loop {
        let candidate = unsafe {
            FindWindowExW(
                parent as *mut std::ffi::c_void,
                after,
                class.as_ptr(),
                std::ptr::null(),
            )
        };
        if candidate.is_null() {
            return std::ptr::null_mut();
        }
        if window_text(candidate).contains(CONTENT_MARKER) {
            return candidate;
        }
        after = candidate;
    }
}

fn window_text(hwnd: *mut std::ffi::c_void) -> String {
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetWindowTextLengthW, GetWindowTextW};
    let len = unsafe { GetWindowTextLengthW(hwnd) };
    if len <= 0 {
        return String::new();
    }
    let mut buf = vec![0u16; (len + 1) as usize];
    let written = unsafe { GetWindowTextW(hwnd, buf.as_mut_ptr(), buf.len() as i32) };
    String::from_utf16_lossy(&buf[..written as usize])
}
