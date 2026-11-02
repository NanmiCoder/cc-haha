use crate::system::runtime::dpi;
use agent_desktop_core::{AdapterError, ErrorCode};
use std::sync::OnceLock;

const S_OK_HRESULT: i32 = 0;
const S_FALSE_HRESULT: i32 = 1;
const RPC_E_CHANGED_MODE_HRESULT: i32 = 0x8001_0106_u32 as i32;
const CO_E_NOT_INITIALIZED_HRESULT: i32 = 0x8004_01F0_u32 as i32;
const APTTYPE_MTA_VALUE: i32 = 1;

#[cfg(target_os = "windows")]
const _: () = {
    assert!(S_OK_HRESULT == windows_sys::Win32::Foundation::S_OK);
    assert!(S_FALSE_HRESULT == windows_sys::Win32::Foundation::S_FALSE);
    assert!(RPC_E_CHANGED_MODE_HRESULT == windows_sys::Win32::Foundation::RPC_E_CHANGED_MODE);
    assert!(CO_E_NOT_INITIALIZED_HRESULT == windows_sys::Win32::Foundation::CO_E_NOTINITIALIZED);
    assert!(APTTYPE_MTA_VALUE == windows_sys::Win32::System::Com::APTTYPE_MTA);
};

type RetainedMtaCookieAddress = usize;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ComApartment {
    OwnedMta,
    BorrowedFromHostMode,
}

impl ComApartment {
    #[cfg(any(test, target_os = "windows"))]
    pub(crate) fn permits_co_uninitialize(self) -> bool {
        matches!(self, ComApartment::OwnedMta)
    }
}

/// Joins the calling thread to the COM multithreaded apartment and applies
/// per-monitor-v2 DPI awareness, for a process this product owns (the CLI).
///
/// `CoInitializeEx` is thread-local, so the process-wide guard here is sound
/// only because the CLI calls this once from its main thread before any COM
/// work. `RPC_E_CHANGED_MODE` means another component already chose this
/// thread's apartment mode: the apartment is borrowed, the bootstrap
/// succeeds, and no `CoUninitialize` is ever scheduled for it.
pub fn ensure_owned_process_mta_and_dpi() -> Result<(), AdapterError> {
    static OWNED_PROCESS_BOOTSTRAP: OnceLock<Result<ComApartment, AdapterError>> = OnceLock::new();
    OWNED_PROCESS_BOOTSTRAP
        .get_or_init(initialize_owned_process_apartment)
        .clone()
        .map(drop)
}

/// Registers process-wide MTA usage and applies per-monitor-v2 DPI awareness,
/// for library hosts (the cdylib) whose threads this product does not own.
///
/// Unlike the thread-local `CoInitializeEx`, `CoIncrementMTAUsage` acts on
/// the whole process, so a process-wide guard is exactly right: the call is
/// sound from any host thread, including an STA host's, and the returned
/// cookie is retained for the life of the process rather than released.
pub fn ensure_hosted_library_mta_and_dpi() -> Result<(), AdapterError> {
    static HOSTED_LIBRARY_BOOTSTRAP: OnceLock<Result<RetainedMtaCookieAddress, AdapterError>> =
        OnceLock::new();
    HOSTED_LIBRARY_BOOTSTRAP
        .get_or_init(initialize_hosted_library_apartment)
        .clone()
        .map(drop)
}

/// Performs the whole hosted-library bootstrap the cdylib needs before it
/// builds an adapter: joins the process-wide MTA, applies per-monitor-v2 DPI
/// awareness, and installs the Windows private-file backend into core.
///
/// The CLI installs the private-file backend from `main` before it parses, but
/// the cdylib has no such entry point, so it performs all three steps here at
/// `build_adapter` time.
#[cfg(target_os = "windows")]
pub fn bootstrap_hosted_library() -> Result<(), AdapterError> {
    ensure_hosted_library_mta_and_dpi()?;
    let _ = agent_desktop_core::install_private_file_ops(Box::new(crate::WindowsPrivateFile));
    Ok(())
}

/// Reports whether a newly spawned thread that never called `CoInitializeEx`
/// observes membership in the multithreaded apartment, which becomes true
/// once the process-wide MTA exists. Read-only: `CoGetApartmentType` never
/// initializes COM, so probing cannot create the state it reports.
pub fn is_mta_established_for_new_threads() -> bool {
    std::thread::Builder::new()
        .name("agent-desktop-mta-probe".into())
        .spawn(|| {
            let (hresult, apartment_type) = imp::current_thread_apartment_type();
            apartment_probe_reports_mta(hresult, apartment_type)
        })
        .ok()
        .and_then(|probe| probe.join().ok())
        .unwrap_or(false)
}

fn initialize_owned_process_apartment() -> Result<ComApartment, AdapterError> {
    #[cfg(test)]
    native_call_probe::OWNED_INITIALIZATIONS.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let apartment =
        classify_co_initialize_hresult(imp::co_initialize_multithreaded()).map_err(|hresult| {
            com_bootstrap_failure(
                "The COM multithreaded apartment could not be initialized",
                hresult,
            )
        })?;
    dpi::ensure_per_monitor_v2()?;
    Ok(apartment)
}

fn initialize_hosted_library_apartment() -> Result<RetainedMtaCookieAddress, AdapterError> {
    #[cfg(test)]
    native_call_probe::HOSTED_INITIALIZATIONS.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let (hresult, cookie_address) = imp::co_increment_mta_usage();
    classify_mta_usage_hresult(hresult).map_err(|failure| {
        com_bootstrap_failure(
            "Process-wide COM MTA usage could not be registered",
            failure,
        )
    })?;
    dpi::ensure_per_monitor_v2()?;
    Ok(cookie_address)
}

pub(crate) fn classify_co_initialize_hresult(hresult: i32) -> Result<ComApartment, i32> {
    match hresult {
        S_OK_HRESULT | S_FALSE_HRESULT => Ok(ComApartment::OwnedMta),
        RPC_E_CHANGED_MODE_HRESULT => Ok(ComApartment::BorrowedFromHostMode),
        failure => Err(failure),
    }
}

pub(crate) fn classify_mta_usage_hresult(hresult: i32) -> Result<(), i32> {
    if hresult >= 0 { Ok(()) } else { Err(hresult) }
}

pub(crate) fn apartment_probe_reports_mta(hresult: i32, apartment_type: i32) -> bool {
    hresult >= 0 && apartment_type == APTTYPE_MTA_VALUE
}

fn com_bootstrap_failure(message: &str, hresult: i32) -> AdapterError {
    AdapterError::new(ErrorCode::Internal, message)
        .with_platform_detail(crate::system::permissions::com_hresult_detail(hresult))
        .with_suggestion(
            "Verify the host process allows COM initialization, then rerun the command",
        )
}

#[cfg(target_os = "windows")]
mod imp {
    use windows_sys::Win32::System::Com::{
        APTTYPE, APTTYPEQUALIFIER, CO_MTA_USAGE_COOKIE, COINIT_MULTITHREADED, CoGetApartmentType,
        CoIncrementMTAUsage, CoInitializeEx,
    };

    pub(super) fn co_initialize_multithreaded() -> i32 {
        unsafe { CoInitializeEx(std::ptr::null(), COINIT_MULTITHREADED as u32) }
    }

    pub(super) fn co_increment_mta_usage() -> (i32, usize) {
        let mut cookie: CO_MTA_USAGE_COOKIE = std::ptr::null_mut();
        let hresult = unsafe { CoIncrementMTAUsage(&mut cookie) };
        (hresult, cookie.addr())
    }

    pub(super) fn current_thread_apartment_type() -> (i32, i32) {
        let mut apartment_type: APTTYPE = 0;
        let mut qualifier: APTTYPEQUALIFIER = 0;
        let hresult = unsafe { CoGetApartmentType(&mut apartment_type, &mut qualifier) };
        (hresult, apartment_type)
    }
}

#[cfg(not(target_os = "windows"))]
mod imp {
    pub(super) fn co_initialize_multithreaded() -> i32 {
        super::S_OK_HRESULT
    }

    pub(super) fn co_increment_mta_usage() -> (i32, usize) {
        (super::S_OK_HRESULT, 0)
    }

    pub(super) fn current_thread_apartment_type() -> (i32, i32) {
        (super::CO_E_NOT_INITIALIZED_HRESULT, 0)
    }
}

#[cfg(test)]
mod native_call_probe {
    use std::sync::atomic::AtomicU32;

    pub(super) static OWNED_INITIALIZATIONS: AtomicU32 = AtomicU32::new(0);
    pub(super) static HOSTED_INITIALIZATIONS: AtomicU32 = AtomicU32::new(0);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::Ordering;

    const E_OUTOFMEMORY_HRESULT: i32 = 0x8007_000E_u32 as i32;
    const APTTYPE_STA_VALUE: i32 = 0;

    #[test]
    fn s_ok_establishes_an_owned_mta() {
        assert_eq!(
            classify_co_initialize_hresult(S_OK_HRESULT),
            Ok(ComApartment::OwnedMta)
        );
    }

    #[test]
    fn s_false_means_the_thread_already_joined_and_stays_owned() {
        assert_eq!(
            classify_co_initialize_hresult(S_FALSE_HRESULT),
            Ok(ComApartment::OwnedMta)
        );
    }

    #[test]
    fn rpc_e_changed_mode_is_borrowed_success_not_failure() {
        assert_eq!(
            classify_co_initialize_hresult(RPC_E_CHANGED_MODE_HRESULT),
            Ok(ComApartment::BorrowedFromHostMode)
        );
    }

    #[test]
    fn a_borrowed_apartment_never_permits_co_uninitialize() {
        assert!(!ComApartment::BorrowedFromHostMode.permits_co_uninitialize());
        assert!(ComApartment::OwnedMta.permits_co_uninitialize());
    }

    #[test]
    fn a_real_co_initialize_failure_stays_a_failure() {
        assert_eq!(
            classify_co_initialize_hresult(E_OUTOFMEMORY_HRESULT),
            Err(E_OUTOFMEMORY_HRESULT)
        );
    }

    #[test]
    fn mta_usage_success_and_failure_split_on_hresult_sign() {
        assert_eq!(classify_mta_usage_hresult(S_OK_HRESULT), Ok(()));
        assert_eq!(
            classify_mta_usage_hresult(E_OUTOFMEMORY_HRESULT),
            Err(E_OUTOFMEMORY_HRESULT)
        );
    }

    #[test]
    fn owned_bootstrap_twice_succeeds_with_one_native_initialization() {
        ensure_owned_process_mta_and_dpi().expect("first owned-process bootstrap");
        ensure_owned_process_mta_and_dpi().expect("second owned-process bootstrap");
        assert_eq!(
            native_call_probe::OWNED_INITIALIZATIONS.load(Ordering::SeqCst),
            1
        );
    }

    #[test]
    fn hosted_bootstrap_twice_succeeds_with_one_native_registration() {
        ensure_hosted_library_mta_and_dpi().expect("first hosted-library bootstrap");
        ensure_hosted_library_mta_and_dpi().expect("second hosted-library bootstrap");
        assert_eq!(
            native_call_probe::HOSTED_INITIALIZATIONS.load(Ordering::SeqCst),
            1
        );
    }

    #[test]
    fn the_probe_requires_mta_membership_not_just_initialized_com() {
        assert!(apartment_probe_reports_mta(S_OK_HRESULT, APTTYPE_MTA_VALUE));
        assert!(!apartment_probe_reports_mta(
            S_OK_HRESULT,
            APTTYPE_STA_VALUE
        ));
        assert!(!apartment_probe_reports_mta(
            CO_E_NOT_INITIALIZED_HRESULT,
            0
        ));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn an_established_mta_is_visible_to_fresh_threads() {
        ensure_hosted_library_mta_and_dpi().expect("hosted-library bootstrap");
        assert!(is_mta_established_for_new_threads());
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn the_canned_probe_reports_no_apartment_off_windows() {
        assert!(!is_mta_established_for_new_threads());
    }
}
