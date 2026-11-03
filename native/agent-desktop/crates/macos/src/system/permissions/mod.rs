use agent_desktop_core::{AdapterError, Deadline, PermissionReport, PermissionState};

const ACCESSIBILITY_SUGGESTION: &str = "Run agent-desktop permissions --guide. It opens System Settings > Privacy & Security > Accessibility (Device Control and Data Access on macOS 27 and later) with a guide that shows which app to drag into the list: the app that launches agent-desktop, such as Terminal, iTerm, or Codex. If macOS lists the built binary separately, add that binary too.";
const SCREEN_RECORDING_SUGGESTION: &str = "Run agent-desktop permissions --guide. It opens System Settings > Privacy & Security > Screen Recording with a guide that shows which app to drag into the list: the app that launches agent-desktop, such as Terminal, iTerm, or Codex. If macOS lists the built binary separately, add that binary too.";
pub(crate) const AUTOMATION_SUGGESTION: &str = "Open System Settings > Privacy & Security > Automation and allow the app that launches agent-desktop, such as Terminal, iTerm, or Codex, to control System Events. If macOS lists the built binary separately, add that binary too.";

const NO_ERR: i32 = 0;
const PROC_NOT_FOUND: i32 = -600;
const ERR_AE_EVENT_NOT_PERMITTED: i32 = -1743;
const ERR_AE_EVENT_WOULD_REQUIRE_USER_CONSENT: i32 = -1744;

#[cfg(target_os = "macos")]
mod imp {
    use accessibility_sys::{
        AXIsProcessTrusted, AXIsProcessTrustedWithOptions, kAXTrustedCheckOptionPrompt,
    };
    use core_foundation::{
        base::TCFType, boolean::CFBoolean, dictionary::CFDictionary, string::CFString,
    };

    pub(super) fn is_trusted() -> bool {
        unsafe { AXIsProcessTrusted() }
    }

    pub(super) fn request_trust() -> bool {
        unsafe {
            let key = CFString::wrap_under_get_rule(kAXTrustedCheckOptionPrompt);
            let val = CFBoolean::true_value();
            let dict = CFDictionary::from_CFType_pairs(&[(key.as_CFType(), val.as_CFType())]);
            AXIsProcessTrustedWithOptions(dict.as_concrete_TypeRef())
        }
    }

    #[link(name = "CoreGraphics", kind = "framework")]
    unsafe extern "C" {
        fn CGPreflightScreenCaptureAccess() -> bool;
        fn CGRequestScreenCaptureAccess() -> bool;
    }

    pub(super) fn screen_recording_granted() -> bool {
        unsafe { CGPreflightScreenCaptureAccess() }
    }

    pub(super) fn request_screen_recording() -> bool {
        unsafe { CGRequestScreenCaptureAccess() }
    }

    const TYPE_APPLICATION_BUNDLE_ID: u32 = 0x6275_6E64;
    const TYPE_WILD_CARD: u32 = 0x2A2A_2A2A;
    const SYSTEM_EVENTS_BUNDLE_ID: &[u8] = b"com.apple.systemevents";

    #[repr(C)]
    struct AEAddressDesc {
        descriptor_type: u32,
        data_handle: *mut std::ffi::c_void,
    }

    #[link(name = "ApplicationServices", kind = "framework")]
    unsafe extern "C" {
        fn AECreateDesc(
            type_code: u32,
            data_ptr: *const std::ffi::c_void,
            data_size: isize,
            result: *mut AEAddressDesc,
        ) -> i32;
        fn AEDisposeDesc(the_aedesc: *mut AEAddressDesc) -> i32;
        fn AEDeterminePermissionToAutomateTarget(
            target: *const AEAddressDesc,
            event_class: u32,
            event_id: u32,
            ask_user_if_needed: u8,
        ) -> i32;
    }

    fn determine_automation_permission(ask_user_if_needed: u8) -> i32 {
        unsafe {
            let mut target = AEAddressDesc {
                descriptor_type: 0,
                data_handle: std::ptr::null_mut(),
            };
            let create_status = AECreateDesc(
                TYPE_APPLICATION_BUNDLE_ID,
                SYSTEM_EVENTS_BUNDLE_ID.as_ptr().cast(),
                SYSTEM_EVENTS_BUNDLE_ID.len() as isize,
                &mut target,
            );
            if create_status != 0 {
                return create_status;
            }
            let status = AEDeterminePermissionToAutomateTarget(
                &target,
                TYPE_WILD_CARD,
                TYPE_WILD_CARD,
                ask_user_if_needed,
            );
            let _ = AEDisposeDesc(&mut target);
            status
        }
    }

    pub(super) fn probe_automation_permission() -> i32 {
        determine_automation_permission(0)
    }

    pub(super) fn request_automation_permission() -> bool {
        determine_automation_permission(1) == 0
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    pub fn is_trusted() -> bool {
        false
    }
    pub fn request_trust() -> bool {
        false
    }
    pub fn screen_recording_granted() -> bool {
        false
    }
    pub fn request_screen_recording() -> bool {
        false
    }
    pub fn probe_automation_permission() -> i32 {
        -600
    }
    pub fn request_automation_permission() -> bool {
        false
    }
}

pub(crate) fn report(deadline: Deadline) -> Result<PermissionReport, AdapterError> {
    deadline.ensure_remaining()?;
    let report = PermissionReport {
        accessibility: accessibility_report_state(),
        screen_recording: screen_recording_report_state(),
        automation: automation_report_state(),
    };
    deadline.ensure_remaining()?;
    Ok(report)
}

pub(crate) fn request_report(deadline: Deadline) -> Result<PermissionReport, AdapterError> {
    request_report_with(
        deadline,
        crate::system::permissions::permission_helper::request,
        report,
    )
}

fn request_report_with(
    deadline: Deadline,
    mut request: impl FnMut(
        crate::system::permissions::permission_operation::PermissionOperation,
        Deadline,
    ) -> Result<bool, AdapterError>,
    report: impl FnOnce(Deadline) -> Result<PermissionReport, AdapterError>,
) -> Result<PermissionReport, AdapterError> {
    deadline.ensure_remaining()?;
    let _ = request(
        crate::system::permissions::permission_operation::PermissionOperation::Accessibility,
        deadline,
    )?;
    deadline.ensure_remaining()?;
    let _ = request(
        crate::system::permissions::permission_operation::PermissionOperation::ScreenRecording,
        deadline,
    )?;
    deadline.ensure_remaining()?;
    let _ = request(
        crate::system::permissions::permission_operation::PermissionOperation::Automation,
        deadline,
    )?;
    deadline.ensure_remaining()?;
    report(deadline)
}

pub(crate) fn prompt_accessibility() -> bool {
    imp::request_trust()
}

pub(crate) fn prompt_screen_recording() -> bool {
    imp::request_screen_recording()
}

pub(crate) fn prompt_automation() -> bool {
    imp::request_automation_permission()
}

pub(crate) fn preflight_accessibility() -> bool {
    imp::is_trusted()
}

pub(crate) fn preflight_screen_recording() -> bool {
    imp::screen_recording_granted()
}

fn permission_state(granted: bool, suggestion: &'static str) -> PermissionState {
    if granted {
        PermissionState::Granted
    } else {
        PermissionState::Denied {
            suggestion: suggestion.into(),
        }
    }
}

fn accessibility_report_state() -> PermissionState {
    permission_state(imp::is_trusted(), ACCESSIBILITY_SUGGESTION)
}

fn screen_recording_report_state() -> PermissionState {
    permission_state(imp::screen_recording_granted(), SCREEN_RECORDING_SUGGESTION)
}

fn automation_report_state() -> PermissionState {
    map_automation_probe(imp::probe_automation_permission())
}

pub(crate) fn require_automation_permission() -> Result<(), AdapterError> {
    let status = imp::probe_automation_permission();
    match status {
        NO_ERR => Ok(()),
        ERR_AE_EVENT_NOT_PERMITTED | ERR_AE_EVENT_WOULD_REQUIRE_USER_CONSENT => {
            Err(automation_permission_error(status))
        }
        _ => Err(AdapterError::new(
            agent_desktop_core::ErrorCode::AppUnresponsive,
            "Could not verify Automation permission without prompting",
        )
        .with_details(serde_json::json!({
            "kind": "automation_permission_probe",
            "os_status": status,
            "target": "System Events",
            "prompted": false,
        }))
        .with_suggestion("Ensure System Events is running, then retry the command")),
    }
}

pub(crate) fn map_automation_probe(status: i32) -> PermissionState {
    match status {
        NO_ERR => PermissionState::Granted,
        ERR_AE_EVENT_NOT_PERMITTED => PermissionState::Denied {
            suggestion: AUTOMATION_SUGGESTION.into(),
        },
        PROC_NOT_FOUND | ERR_AE_EVENT_WOULD_REQUIRE_USER_CONSENT => PermissionState::Unknown,
        _ => PermissionState::Unknown,
    }
}

pub(crate) fn map_automation_command_failure(
    status: std::process::ExitStatus,
    stderr: &[u8],
) -> AdapterError {
    let detail = bounded_platform_text(stderr);
    if automation_denial_text(&detail) {
        return automation_permission_error(ERR_AE_EVENT_NOT_PERMITTED)
            .with_platform_detail(detail);
    }
    AdapterError::new(
        agent_desktop_core::ErrorCode::ActionFailed,
        "System Events did not complete the requested Automation operation",
    )
    .with_platform_detail(detail)
    .with_details(serde_json::json!({
        "kind": "automation_command",
        "exit_code": status.code(),
        "target": "System Events",
    }))
}

fn automation_permission_error(status: i32) -> AdapterError {
    AdapterError::new(
        agent_desktop_core::ErrorCode::PermDenied,
        "Automation permission for System Events is required",
    )
    .with_suggestion(AUTOMATION_SUGGESTION)
    .with_details(serde_json::json!({
        "kind": "automation_permission",
        "os_status": status,
        "target": "System Events",
        "prompted": false,
    }))
}

fn automation_denial_text(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    lower.contains("-1743")
        || lower.contains("not authorized to send apple events")
        || lower.contains("not permitted to send apple events")
}

fn bounded_platform_text(bytes: &[u8]) -> String {
    const MAX_BYTES: usize = 4 * 1024;
    String::from_utf8_lossy(&bytes[..bytes.len().min(MAX_BYTES)]).into_owned()
}

pub(crate) mod permission_guide;
pub(crate) mod permission_helper;
pub(crate) mod permission_operation;
#[cfg(test)]
#[path = "permissions_tests.rs"]
mod tests;
