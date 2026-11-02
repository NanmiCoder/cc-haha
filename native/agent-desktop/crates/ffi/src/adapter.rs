use crate::convert::string::optional_adapter_string;
use crate::error::{self, AdResult};
use crate::ffi_try::{trap_panic, trap_panic_ptr, trap_panic_void};
use agent_desktop_core::PlatformAdapter;
#[cfg(any(feature = "stub-adapter", test))]
use agent_desktop_core::{ActionOps, InputOps, ObservationOps, SystemOps};
use agent_desktop_core::{
    AdapterError, AppError, PermissionState,
    context::{CommandContext, validate_session_id},
};
use std::collections::HashMap;
use std::ffi::c_char;
use std::sync::atomic::AtomicUsize;
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};

static ADAPTERS: OnceLock<Mutex<HashMap<usize, Arc<AdAdapter>>>> = OnceLock::new();
static NEXT_ADAPTER_ID: AtomicUsize = AtomicUsize::new(1);

pub struct AdAdapter {
    pub(crate) inner: Box<dyn PlatformAdapter>,
    pub(crate) session_id: Option<String>,
    pub(crate) _session_lease: Option<agent_desktop_core::session::SessionLivenessLease>,
}

fn adapters() -> &'static Mutex<HashMap<usize, Arc<AdAdapter>>> {
    ADAPTERS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn lock_adapters() -> MutexGuard<'static, HashMap<usize, Arc<AdAdapter>>> {
    match adapters().lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}

pub(crate) fn register_adapter(adapter: AdAdapter) -> Result<*mut AdAdapter, AdapterError> {
    let id = crate::opaque_id::allocate(&NEXT_ADAPTER_ID, "Adapter handle")?;
    if lock_adapters().insert(id, Arc::new(adapter)).is_some() {
        return Err(AdapterError::internal(
            "Adapter handle identifier collision",
        ));
    }
    Ok(std::ptr::with_exposed_provenance_mut(id))
}

pub(crate) fn adapter_id(adapter: *const AdAdapter) -> Result<usize, AdapterError> {
    if adapter.is_null() {
        return Err(AdapterError::new(
            agent_desktop_core::ErrorCode::InvalidArgs,
            "adapter is null",
        ));
    }
    Ok(adapter.addr())
}

pub(crate) fn lookup_adapter(adapter: *const AdAdapter) -> Result<Arc<AdAdapter>, AdapterError> {
    let id = adapter_id(adapter)?;
    lock_adapters().get(&id).cloned().ok_or_else(|| {
        AdapterError::new(
            agent_desktop_core::ErrorCode::InvalidArgs,
            "adapter handle is invalid or has already been destroyed",
        )
    })
}

macro_rules! acquire_adapter {
    ($adapter:expr) => {{
        match $crate::adapter::lookup_adapter($adapter) {
            Ok(adapter) => adapter,
            Err(error) => {
                $crate::error::set_last_error(&error);
                return $crate::error::last_error_code();
            }
        }
    }};
}

pub(crate) use acquire_adapter;

/// A no-op adapter used under the `stub-adapter` Cargo feature.
///
/// Every method delegates to the `PlatformAdapter` trait defaults, all of
/// which return `not_supported()` errors. `permission_report()` returns
/// `Unknown` via the trait default, so `ad_check_permissions` yields
/// `ErrPlatformNotSupported` on a stub build — the honest signal that the
/// adapter never probed permissions, rather than that one was denied.
#[cfg(feature = "stub-adapter")]
struct StubAdapter;

#[cfg(feature = "stub-adapter")]
impl ObservationOps for StubAdapter {}

#[cfg(feature = "stub-adapter")]
impl ActionOps for StubAdapter {}

#[cfg(feature = "stub-adapter")]
impl InputOps for StubAdapter {}

#[cfg(feature = "stub-adapter")]
impl SystemOps for StubAdapter {}

#[cfg(feature = "stub-adapter")]
fn build_adapter() -> Result<Box<dyn PlatformAdapter>, AdapterError> {
    Ok(Box::new(StubAdapter))
}

#[cfg(not(feature = "stub-adapter"))]
fn build_adapter() -> Result<Box<dyn PlatformAdapter>, AdapterError> {
    #[cfg(target_os = "macos")]
    {
        agent_desktop_macos::ensure_cocoa_multithreaded()?;
        Ok(Box::new(agent_desktop_macos::MacOSAdapter::new()))
    }

    #[cfg(target_os = "windows")]
    {
        agent_desktop_windows::bootstrap_hosted_library()?;
        Ok(Box::new(agent_desktop_windows::WindowsAdapter::new()))
    }

    #[cfg(target_os = "linux")]
    {
        Ok(Box::new(agent_desktop_linux::LinuxAdapter::new()))
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    compile_error!("Unsupported platform")
}

fn create_adapter(session_id: Option<String>) -> *mut AdAdapter {
    let inner = match build_adapter() {
        Ok(inner) => inner,
        Err(error) => {
            error::set_last_error(&error);
            return std::ptr::null_mut();
        }
    };
    let session_lease = match crate::session_lease::acquire(session_id.as_deref()) {
        Ok(lease) => lease,
        Err(error) => {
            error::set_last_error(&error);
            return std::ptr::null_mut();
        }
    };
    match register_adapter(AdAdapter {
        inner,
        session_id,
        _session_lease: session_lease,
    }) {
        Ok(handle) => handle,
        Err(error) => {
            error::set_last_error(&error);
            std::ptr::null_mut()
        }
    }
}

/// Builds a platform adapter for the current OS and returns an opaque
/// handle. Returns null on allocation failure or if a Rust panic is
/// caught at the FFI boundary (inspect `ad_last_error_*` for details).
///
/// The returned pointer is owned by the caller and must be released with
/// `ad_adapter_destroy`. Creating and destroying adapters is cheap; the
/// common pattern is one adapter per process lifetime.
#[unsafe(no_mangle)]
pub extern "C" fn ad_adapter_create() -> *mut AdAdapter {
    trap_panic_ptr(|| create_adapter(None))
}

/// Builds a session-scoped platform adapter. `session` may be:
/// - null: equivalent to `ad_adapter_create()` (no session).
/// - a valid session id (1-64 ASCII alphanumeric / `-` / `_` chars): associates
///   the adapter with that session for refmap persistence.
/// - empty, too long, containing invalid characters, or invalid UTF-8: sets
///   `ErrInvalidArgs` in the last-error slot and returns null; no adapter is
///   allocated.
///
/// The returned pointer must be released with `ad_adapter_destroy`.
///
/// # Safety
///
/// `session` must be null or point to readable memory that is NUL-terminated
/// within `AD_MAX_STRING_BYTES + 1` bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ad_adapter_create_with_session(session: *const c_char) -> *mut AdAdapter {
    trap_panic_ptr(|| {
        let session_id = match optional_adapter_string(session, "session") {
            Ok(opt) => opt,
            Err(err) => {
                error::set_last_error(&err);
                return std::ptr::null_mut();
            }
        };
        if let Some(id) = session_id.as_deref() {
            if let Err(app_err) = validate_session_id(id) {
                let adapter_err = match app_err {
                    AppError::Adapter(e) => e,
                    other => AdapterError::new(
                        agent_desktop_core::ErrorCode::InvalidArgs,
                        other.to_string(),
                    ),
                };
                error::set_last_error(&adapter_err);
                return std::ptr::null_mut();
            }
        }
        create_adapter(session_id)
    })
}

/// # Safety
///
/// `adapter` must be a pointer returned by `ad_adapter_create` or
/// `ad_adapter_create_with_session`, or null. After this call the pointer
/// is invalid and must not be used.
///
/// Calls that acquired the adapter before destruction retain it until they
/// return. Calls beginning after destruction fail with `ErrInvalidArgs`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ad_adapter_destroy(adapter: *mut AdAdapter) {
    trap_panic_void(|| {
        if !adapter.is_null() {
            let id = adapter.addr();
            if lock_adapters().remove(&id).is_none() {
                error::set_last_error(&AdapterError::new(
                    agent_desktop_core::ErrorCode::InvalidArgs,
                    "adapter handle is invalid or has already been destroyed",
                ));
            }
        }
    })
}

/// # Safety
///
/// `adapter` must be a non-null pointer returned by `ad_adapter_create` that
/// has not yet been destroyed.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ad_check_permissions(adapter: *const AdAdapter) -> AdResult {
    trap_panic(|| {
        let adapter = acquire_adapter!(adapter);
        let deadline = crate::operation::operation_deadline!();
        let report = match adapter.inner.permission_report(deadline) {
            Ok(report) => report,
            Err(error) => {
                error::set_last_error(&error);
                return error::last_error_code();
            }
        };
        match report.accessibility {
            PermissionState::Granted => AdResult::Ok,
            PermissionState::Denied { suggestion } => {
                error::set_last_error(
                    &agent_desktop_core::AdapterError::new(
                        agent_desktop_core::ErrorCode::PermDenied,
                        "Accessibility permission not granted",
                    )
                    .with_suggestion(suggestion),
                );
                AdResult::ErrPermDenied
            }
            PermissionState::NotRequired => AdResult::Ok,
            PermissionState::Unknown => unknown_permission_result(adapter.inner.as_ref()),
        }
    })
}

impl AdAdapter {
    /// Builds a `CommandContext` from this adapter's session. Callers that
    /// need a context for context-taking commands (snapshot, status, wait)
    /// call this at the FFI entry boundary.
    pub(crate) fn command_context(&self) -> Result<CommandContext, AppError> {
        CommandContext::new(self.session_id.clone(), None, false)
    }
}

fn unknown_permission_result(adapter: &dyn PlatformAdapter) -> AdResult {
    let (code, message, suggestion) = if adapter.unknown_accessibility_means_unsupported() {
        (
            agent_desktop_core::ErrorCode::PlatformNotSupported,
            "Accessibility permission state is unknown because this platform adapter does not support permission probing",
            "Use a platform adapter with implemented permission probing before executing desktop actions.",
        )
    } else {
        (
            agent_desktop_core::ErrorCode::Internal,
            "Accessibility permission state is unknown",
            "Run the platform-specific permission report before executing desktop actions.",
        )
    };
    let err = agent_desktop_core::AdapterError::new(code, message).with_suggestion(suggestion);
    error::set_last_error(&err);
    crate::error::last_error_code()
}

#[cfg(test)]
#[path = "adapter_tests.rs"]
mod tests;
