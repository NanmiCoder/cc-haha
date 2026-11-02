use agent_desktop_core::{AdapterError, Deadline, ErrorCode, InteractionPolicy, KeyCombo};
use std::time::{Duration, Instant};

use crate::tree::AXElement;

pub(crate) fn press(
    element: &AXElement,
    combo: &KeyCombo,
    policy: InteractionPolicy,
    deadline: Deadline,
) -> Result<(), AdapterError> {
    press_sequence(element, std::slice::from_ref(combo), policy, deadline)
}

pub(crate) fn press_sequence(
    element: &AXElement,
    combos: &[KeyCombo],
    policy: InteractionPolicy,
    deadline: Deadline,
) -> Result<(), AdapterError> {
    let mut delivery = crate::actions::DeliveryTracker::default();
    let identity = prepare_target(element, policy, deadline, &mut delivery)
        .map_err(|error| delivery.annotate(error))?;
    let pid = identity.pid();
    for combo in combos {
        verify_delivery_target(element, identity, deadline)
            .map_err(|error| delivery.annotate(error))?;
        crate::input::keyboard::synthesize_key(combo, Some(pid), deadline)
            .map_err(|error| delivery.annotate(error))?;
        delivery.mark_delivered();
    }
    Ok(())
}

pub(crate) fn type_text(
    element: &AXElement,
    text: &str,
    policy: InteractionPolicy,
    deadline: Deadline,
) -> Result<(), AdapterError> {
    crate::input::keyboard::preflight_text(text, deadline)?;
    let mut delivery = crate::actions::DeliveryTracker::default();
    let identity = prepare_target(element, policy, deadline, &mut delivery)
        .map_err(|error| delivery.annotate(error))?;
    let pid = identity.pid();
    crate::input::keyboard::synthesize_text(text, pid, deadline, |deadline| {
        verify_delivery_target(element, identity, deadline)
    })
    .map_err(|error| delivery.annotate(error))
}

fn prepare_target(
    element: &AXElement,
    policy: InteractionPolicy,
    deadline: Deadline,
    delivery: &mut crate::actions::DeliveryTracker,
) -> Result<crate::system::process::process_identity::ProcessIdentity, AdapterError> {
    if !policy.allow_focus_steal {
        return Err(AdapterError::policy_denied_for_policy(
            "Physical keyboard fallback requires focus permission",
            policy,
        ));
    }
    let pid = crate::system::app::app_ops::pid_from_element(element, deadline)
        .filter(|pid| *pid > 0)
        .ok_or_else(|| {
            AdapterError::new(
                ErrorCode::StaleRef,
                "Keyboard target no longer has a valid owning process",
            )
        })?;
    let identity = crate::system::process::process_identity::ProcessIdentity::capture(pid)?
        .ok_or_else(|| {
            AdapterError::new(
                ErrorCode::StaleRef,
                "Keyboard target process exited before physical input preparation",
            )
        })?;
    if let Some(window) = target_window(element, deadline)? {
        crate::system::focus::verify_window_main(&window, deadline)?;
    }
    crate::system::focus::verify_app_focused(pid, deadline)?;
    prepare(element, deadline)?;
    if !crate::actions::ax_helpers::ax_focus_or_err(element, deadline)? {
        return Err(AdapterError::new(
            ErrorCode::ActionNotSupported,
            "Target element could not be focused for keyboard input",
        )
        .with_disposition(agent_desktop_core::DeliverySemantics::not_delivered()));
    }
    delivery.mark_delivered();
    wait_for_focused_element(element, pid, deadline)?;
    crate::system::focus::verify_app_focused(pid, deadline)?;
    verify_delivery_target(element, identity, deadline)?;
    Ok(identity)
}

fn verify_delivery_target(
    expected: &AXElement,
    identity: crate::system::process::process_identity::ProcessIdentity,
    deadline: Deadline,
) -> Result<(), AdapterError> {
    if !identity.still_matches()? {
        return Err(AdapterError::new(
            ErrorCode::StaleRef,
            "Keyboard target process instance changed before physical input delivery",
        )
        .with_disposition(agent_desktop_core::DeliverySemantics::not_delivered()));
    }
    verify_focused_element(expected, identity.pid(), deadline)
}

fn target_window(
    element: &AXElement,
    deadline: Deadline,
) -> Result<Option<AXElement>, AdapterError> {
    prepare(element, deadline)?;
    let result = crate::tree::properties::attributes::copy_element_attr_result(
        element, "AXWindow", deadline,
    );
    deadline.ensure_remaining()?;
    result.map_err(|error| read_error("AXWindow", error))
}

fn wait_for_focused_element(
    expected: &AXElement,
    pid: i32,
    deadline: Deadline,
) -> Result<(), AdapterError> {
    let local_deadline = Instant::now() + Duration::from_millis(500);
    loop {
        if focused_element_matches(expected, pid, deadline)? {
            return Ok(());
        }
        deadline.ensure_remaining()?;
        if Instant::now() >= local_deadline {
            return Err(AdapterError::timeout(
                "Target element did not become focused before keyboard delivery",
            )
            .with_disposition(agent_desktop_core::DeliverySemantics::not_delivered()));
        }
        let pause = deadline.remaining_slice(Duration::from_millis(5))?;
        std::thread::sleep(pause.min(Duration::from_millis(5)));
    }
}

fn verify_focused_element(
    expected: &AXElement,
    pid: i32,
    deadline: Deadline,
) -> Result<(), AdapterError> {
    crate::system::focus::verify_app_focused(pid, deadline)?;
    if focused_element_matches(expected, pid, deadline)? {
        return Ok(());
    }
    Err(AdapterError::new(
        ErrorCode::ActionFailed,
        "Target element lost focus before PID-targeted keyboard delivery",
    )
    .with_disposition(agent_desktop_core::DeliverySemantics::not_delivered()))
}

fn focused_element_matches(
    expected: &AXElement,
    pid: i32,
    deadline: Deadline,
) -> Result<bool, AdapterError> {
    let app = crate::tree::element_for_pid(pid);
    prepare(&app, deadline)?;
    let result = crate::tree::properties::attributes::copy_element_attr_result(
        &app,
        "AXFocusedUIElement",
        deadline,
    );
    deadline.ensure_remaining()?;
    let focused = result.map_err(|error| read_error("AXFocusedUIElement", error))?;
    Ok(focused.is_some_and(|focused| crate::tree::same_element(&focused, expected)))
}

fn prepare(element: &AXElement, deadline: Deadline) -> Result<(), AdapterError> {
    crate::tree::properties::attributes::set_messaging_timeout(element, deadline)
}

fn read_error(attribute: &str, error: i32) -> AdapterError {
    use accessibility_sys::{
        kAXErrorAPIDisabled, kAXErrorCannotComplete, kAXErrorInvalidUIElement,
    };

    let code = if error == kAXErrorAPIDisabled {
        ErrorCode::PermDenied
    } else if error == kAXErrorCannotComplete {
        ErrorCode::Timeout
    } else if error == kAXErrorInvalidUIElement {
        ErrorCode::StaleRef
    } else {
        ErrorCode::ActionFailed
    };
    AdapterError::new(
        code,
        format!("Could not read {attribute} for keyboard targeting"),
    )
    .with_details(serde_json::json!({
        "attribute": attribute,
        "ax_error": error,
    }))
    .with_disposition(agent_desktop_core::DeliverySemantics::not_delivered())
}
