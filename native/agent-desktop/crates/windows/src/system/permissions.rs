use agent_desktop_core::{AdapterError, Deadline, PermissionReport, PermissionState};

const ACCESSIBILITY_SUGGESTION: &str = "Run agent-desktop in an interactive desktop session as a user allowed to use the UI Automation COM runtime; restricted tokens and AppContainer processes are denied UIA access.";

pub(crate) use crate::system::runtime::hresult::com_hresult_detail;
use crate::system::runtime::hresult::{E_ACCESSDENIED, S_OK};

#[cfg(target_os = "windows")]
mod imp {
    use windows_sys::Win32::System::Com::{
        CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED, CoCreateInstance, CoInitializeEx,
        CoUninitialize,
    };
    use windows_sys::core::{GUID, IID_IUnknown, IUnknown_Vtbl};

    use crate::system::runtime::com_runtime::classify_co_initialize_hresult;

    const CLSID_CUIAUTOMATION: GUID = GUID::from_u128(0xff48dba4_60ef_4201_aa87_54103eef594e);

    pub(super) fn probe_uia_access() -> i32 {
        unsafe {
            let init_status = CoInitializeEx(core::ptr::null(), COINIT_MULTITHREADED as u32);
            let apartment = match classify_co_initialize_hresult(init_status) {
                Ok(apartment) => apartment,
                Err(failure) => return failure,
            };
            let mut instance: *mut core::ffi::c_void = core::ptr::null_mut();
            let create_status = CoCreateInstance(
                &CLSID_CUIAUTOMATION,
                core::ptr::null_mut(),
                CLSCTX_INPROC_SERVER,
                &IID_IUnknown,
                &mut instance,
            );
            release_instance(instance);
            if apartment.permits_co_uninitialize() {
                CoUninitialize();
            }
            create_status
        }
    }

    unsafe fn release_instance(instance: *mut core::ffi::c_void) {
        if instance.is_null() {
            return;
        }
        let vtable = unsafe { *instance.cast::<*const IUnknown_Vtbl>() };
        unsafe {
            ((*vtable).Release)(instance);
        }
    }

    pub(super) fn probe_capture_availability() -> Option<bool> {
        if crate::system::capture::capture_modern::modern_is_supported() {
            return Some(true);
        }
        Some(legacy_display_capture_possible())
    }

    fn legacy_display_capture_possible() -> bool {
        use windows_sys::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_CMONITORS};
        unsafe { GetSystemMetrics(SM_CMONITORS) > 0 }
    }
}

#[cfg(not(target_os = "windows"))]
mod imp {
    const E_NOTIMPL: i32 = 0x8000_4001_u32 as i32;

    pub(super) fn probe_uia_access() -> i32 {
        E_NOTIMPL
    }

    pub(super) fn probe_capture_availability() -> Option<bool> {
        None
    }
}

pub(crate) fn report(deadline: Deadline) -> Result<PermissionReport, AdapterError> {
    deadline.ensure_remaining()?;
    report_from_probed_uia(deadline, imp::probe_uia_access())
}

pub(crate) fn request_report(deadline: Deadline) -> Result<PermissionReport, AdapterError> {
    request_report_with(deadline, imp::probe_uia_access, report_from_probed_uia)
}

fn request_report_with(
    deadline: Deadline,
    probe: impl FnOnce() -> i32,
    report: impl FnOnce(Deadline, i32) -> Result<PermissionReport, AdapterError>,
) -> Result<PermissionReport, AdapterError> {
    deadline.ensure_remaining()?;
    let hresult = probe();
    deadline.ensure_remaining()?;
    if matches!(map_uia_access(hresult), PermissionState::Denied { .. }) {
        return Err(uia_access_denied_error(hresult));
    }
    report(deadline, hresult)
}

fn report_from_probed_uia(
    deadline: Deadline,
    uia_hresult: i32,
) -> Result<PermissionReport, AdapterError> {
    let report = PermissionReport {
        accessibility: map_uia_access(uia_hresult),
        screen_recording: screen_recording_report_state(),
        automation: automation_report_state(),
    };
    deadline.ensure_remaining()?;
    Ok(report)
}

pub(crate) fn map_uia_access(hresult: i32) -> PermissionState {
    match hresult {
        S_OK => PermissionState::Granted,
        E_ACCESSDENIED => PermissionState::Denied {
            suggestion: ACCESSIBILITY_SUGGESTION.into(),
        },
        _ => PermissionState::Unknown,
    }
}

pub(crate) fn map_capture_availability(availability: Option<bool>) -> PermissionState {
    match availability {
        Some(true) => PermissionState::NotRequired,
        Some(false) | None => PermissionState::Unknown,
    }
}

pub(crate) fn uia_access_denied_error(hresult: i32) -> AdapterError {
    AdapterError::new(
        agent_desktop_core::ErrorCode::PermDenied,
        "UI Automation access is denied for this process",
    )
    .with_suggestion(ACCESSIBILITY_SUGGESTION)
    .with_platform_detail(com_hresult_detail(hresult))
}

fn screen_recording_report_state() -> PermissionState {
    map_capture_availability(imp::probe_capture_availability())
}

fn automation_report_state() -> PermissionState {
    PermissionState::NotRequired
}

#[cfg(test)]
#[path = "permissions_tests.rs"]
mod tests;
