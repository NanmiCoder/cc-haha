#![allow(dead_code, unused_imports)]
#![allow(improper_ctypes)]

pub use agent_desktop_ffi::error::AdResult;
pub use agent_desktop_ffi::{
    AdAction, AdActionResult, AdActionStep, AdAdapter, AdAppList, AdDirection, AdDragParams,
    AdElementState, AdExactRefEntry, AdExactSurfaceInfo, AdExactSurfaceList, AdExactWindowInfo,
    AdExactWindowList, AdFindQuery, AdKeyCombo, AdNativeHandle, AdNotificationActionRequest,
    AdNotificationIdentity, AdOptionalU64, AdOptionalUsize, AdPoint, AdPolicyKind, AdRect,
    AdRefEntry, AdScrollParams, AdWaitArgs, AdWaitMode, AdWaitPredicate, AdWaitScope,
    AdWaitSurfaceModes,
};
pub use std::ffi::CStr;
pub use std::os::raw::c_char;

#[cfg(target_os = "windows")]
pub mod win32_fixture;

use std::sync::{
    Mutex,
    atomic::{AtomicU64, Ordering},
};

static HOME_LOCK: Mutex<()> = Mutex::new(());
static HOME_ID: AtomicU64 = AtomicU64::new(1);

/// Clears AGENT_DESKTOP_HOME rather than pinning it: the two layout branches
/// produce different paths, and a pinned var breaks test layout assumptions.
struct IsolatedHome {
    _lock: std::sync::MutexGuard<'static, ()>,
    path: std::path::PathBuf,
    previous: Option<std::ffi::OsString>,
    previous_state_root: Option<std::ffi::OsString>,
}

impl IsolatedHome {
    fn enter() -> Self {
        let lock = HOME_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let id = HOME_ID.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "agent-desktop-ffi-test-{}-{id}",
            std::process::id()
        ));
        std::fs::create_dir_all(&path).expect("create isolated FFI test HOME");
        let previous = std::env::var_os("HOME");
        let previous_state_root = std::env::var_os("AGENT_DESKTOP_HOME");
        unsafe { std::env::set_var("HOME", &path) };
        unsafe { std::env::remove_var("AGENT_DESKTOP_HOME") };
        Self {
            _lock: lock,
            path,
            previous,
            previous_state_root,
        }
    }
}

impl Drop for IsolatedHome {
    fn drop(&mut self) {
        match self.previous.as_ref() {
            Some(previous) => unsafe { std::env::set_var("HOME", previous) },
            None => unsafe { std::env::remove_var("HOME") },
        }
        match self.previous_state_root.as_ref() {
            Some(previous) => unsafe { std::env::set_var("AGENT_DESKTOP_HOME", previous) },
            None => unsafe { std::env::remove_var("AGENT_DESKTOP_HOME") },
        }
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

unsafe extern "C" {
    pub fn ad_abi_version() -> u32;
    pub fn ad_init(expected_major: u32) -> AdResult;
    pub fn ad_version(out: *mut *mut c_char) -> AdResult;
    pub fn ad_free_string(s: *mut c_char);
    pub fn ad_notification_action(
        adapter: *const AdAdapter,
        request: *const AdNotificationActionRequest,
        out: *mut AdActionResult,
    ) -> AdResult;
    pub fn ad_set_log_callback(
        cb: Option<unsafe extern "C" fn(level: i32, msg: *const c_char)>,
    ) -> AdResult;

    pub fn ad_ref_entry_size() -> usize;
    pub fn ad_exact_ref_entry_size() -> usize;
    pub fn ad_exact_surface_info_size() -> usize;
    pub fn ad_exact_window_info_size() -> usize;
    pub fn ad_action_size() -> usize;
    pub fn ad_action_step_size() -> usize;
    pub fn ad_action_result_size() -> usize;
    pub fn ad_element_state_size() -> usize;
    pub fn ad_wait_args_size() -> usize;

    pub fn ad_wait(
        adapter: *const AdAdapter,
        args: *const AdWaitArgs,
        out: *mut *mut c_char,
    ) -> AdResult;

    pub fn ad_adapter_create() -> *mut AdAdapter;
    pub fn ad_adapter_create_with_session(session: *const c_char) -> *mut AdAdapter;
    pub fn ad_adapter_destroy(adapter: *mut AdAdapter);
    pub fn ad_check_permissions(adapter: *const AdAdapter) -> AdResult;

    pub fn ad_last_error_code() -> AdResult;
    pub fn ad_last_error_message() -> *const c_char;
    pub fn ad_last_error_details() -> *const c_char;

    pub fn ad_list_apps(adapter: *const AdAdapter, out: *mut *mut AdAppList) -> AdResult;
    pub fn ad_app_list_count(list: *const AdAppList) -> u32;
    pub fn ad_app_list_get(list: *const AdAppList, index: u32) -> *const u8;
    pub fn ad_app_list_free(list: *mut AdAppList);
    pub fn ad_get_clipboard(adapter: *const AdAdapter, out: *mut *mut c_char) -> AdResult;
    pub fn ad_set_clipboard(adapter: *const AdAdapter, text: *const c_char) -> AdResult;
    pub fn ad_clear_clipboard(adapter: *const AdAdapter) -> AdResult;

    pub fn ad_list_windows_exact(
        adapter: *const AdAdapter,
        app_filter: *const c_char,
        focused_only: bool,
        out: *mut *mut AdExactWindowList,
    ) -> AdResult;
    pub fn ad_exact_window_list_count(list: *const AdExactWindowList) -> u32;
    pub fn ad_exact_window_list_get(
        list: *const AdExactWindowList,
        index: u32,
    ) -> *const AdExactWindowInfo;
    pub fn ad_exact_window_list_free(list: *mut AdExactWindowList);
    pub fn ad_list_surfaces_exact(
        adapter: *const AdAdapter,
        pid: u32,
        out: *mut *mut AdExactSurfaceList,
    ) -> AdResult;
    pub fn ad_exact_surface_list_count(list: *const AdExactSurfaceList) -> u32;
    pub fn ad_exact_surface_list_get(
        list: *const AdExactSurfaceList,
        index: u32,
    ) -> *const AdExactSurfaceInfo;
    pub fn ad_exact_surface_list_free(list: *mut AdExactSurfaceList);

    pub fn ad_launch_app_exact(
        adapter: *const AdAdapter,
        id: *const c_char,
        timeout_ms: u64,
        out: *mut AdExactWindowInfo,
    ) -> AdResult;

    pub fn ad_execute_action(
        adapter: *const AdAdapter,
        handle: *const AdNativeHandle,
        action: *const AdAction,
        out: *mut AdActionResult,
    ) -> AdResult;
    pub fn ad_execute_action_with_policy(
        adapter: *const AdAdapter,
        handle: *const AdNativeHandle,
        action: *const AdAction,
        policy: i32,
        out: *mut AdActionResult,
    ) -> AdResult;
    pub fn ad_execute_ref_action_exact_with_policy(
        adapter: *const AdAdapter,
        entry: *const AdExactRefEntry,
        action: *const AdAction,
        policy: i32,
        out: *mut AdActionResult,
    ) -> AdResult;
    pub fn ad_free_action_result(result: *mut AdActionResult);

    pub fn ad_find_exact(
        adapter: *const AdAdapter,
        win: *const AdExactWindowInfo,
        query: *const AdFindQuery,
        out: *mut AdNativeHandle,
    ) -> AdResult;

    pub fn ad_free_handle(adapter: *const AdAdapter, handle: *mut AdNativeHandle) -> AdResult;

    pub fn ad_resolve_element_exact(
        adapter: *const AdAdapter,
        entry: *const AdExactRefEntry,
        out: *mut AdNativeHandle,
    ) -> AdResult;

    pub fn ad_snapshot(
        adapter: *const AdAdapter,
        app: *const c_char,
        surface: i32,
        max_depth: u8,
        interactive_only: bool,
        compact: bool,
        out: *mut *mut c_char,
    ) -> AdResult;
    pub fn ad_status(adapter: *const AdAdapter, out: *mut *mut c_char) -> AdResult;

    pub fn ad_execute_by_ref(
        adapter: *const AdAdapter,
        ref_id: *const c_char,
        action: *const AdAction,
        policy: i32,
        out: *mut *mut c_char,
    ) -> AdResult;
    pub fn ad_execute_by_ref_timeout(
        adapter: *const AdAdapter,
        ref_id: *const c_char,
        action: *const AdAction,
        policy: i32,
        timeout_ms: i64,
        out: *mut *mut c_char,
    ) -> AdResult;

}

pub fn with_adapter<F: FnOnce(*mut AdAdapter)>(body: F) {
    let _home = IsolatedHome::enter();
    unsafe {
        let adapter = ad_adapter_create();
        assert!(!adapter.is_null(), "ad_adapter_create must not return null");
        body(adapter);
        ad_adapter_destroy(adapter);
    }
}

pub fn with_isolated_home<F: FnOnce()>(body: F) {
    let _home = IsolatedHome::enter();
    body();
}

pub fn default_exact_ref_entry() -> AdExactRefEntry {
    let mut entry: AdExactRefEntry = unsafe { std::mem::zeroed() };
    entry.version = agent_desktop_ffi::AD_EXACT_REF_ENTRY_VERSION;
    entry.size = std::mem::size_of::<AdExactRefEntry>() as u32;
    entry
}

/// Depth-first search over a decoded envelope (or any JSON subtree of one)
/// for the first value satisfying `matches`. Walks every object field and
/// every array element rather than a fixed key such as `children`, so it
/// finds a match wherever the schema puts it. `searched` counts every value
/// visited, for a caller's own diagnostic message on a failed search.
pub fn find_ref_in_tree(
    value: &serde_json::Value,
    searched: &mut usize,
    matches: &impl Fn(&serde_json::Value) -> Option<String>,
) -> Option<String> {
    *searched += 1;
    if let Some(found) = matches(value) {
        return Some(found);
    }
    match value {
        serde_json::Value::Object(map) => map
            .values()
            .find_map(|child| find_ref_in_tree(child, searched, matches)),
        serde_json::Value::Array(items) => items
            .iter()
            .find_map(|child| find_ref_in_tree(child, searched, matches)),
        _ => None,
    }
}

pub fn default_action() -> AdAction {
    AdAction {
        kind: 0,
        text: std::ptr::null(),
        scroll: AdScrollParams {
            direction: AdDirection::Down as i32,
            amount: 0,
        },
        key: AdKeyCombo {
            key: std::ptr::null(),
            modifiers: std::ptr::null(),
            modifier_count: 0,
        },
        drag: AdDragParams {
            from: AdPoint { x: 0.0, y: 0.0 },
            to: AdPoint { x: 0.0, y: 0.0 },
            duration_ms: 0,
            drop_delay_ms: 0,
        },
    }
}
