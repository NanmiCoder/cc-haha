use agent_desktop_core::{
    AdapterError, Deadline, DeliverySemantics, ErrorCode, SnapshotSurface, WindowInfo,
};

pub(crate) use super::shell_surface_kinds::{
    SurfaceDismiss, SurfaceFamily, SurfaceKindRow, SurfaceRaise, row_for,
};

#[cfg(target_os = "windows")]
use crate::system::window::window_enum::WindowHandle;

/// Resolves an already-present shell surface to the identity the window
/// observation stack consumes. Reads only; never raises, and therefore takes
/// no interaction policy - which is what makes it callable headless.
pub(crate) fn resolve_surface(
    kind: SnapshotSurface,
    deadline: Deadline,
) -> Result<Option<WindowInfo>, AdapterError> {
    let Some(row) = row_for(kind) else {
        return Err(unknown_surface_error(kind));
    };
    resolve_row(row, deadline)
}

pub(in crate::system) fn resolve_row(
    row: &SurfaceKindRow,
    deadline: Deadline,
) -> Result<Option<WindowInfo>, AdapterError> {
    deadline.ensure_remaining()?;
    if !row.exists_on_build {
        return Err(refusal_error(row));
    }
    resolve_present_row(row)
}

pub(crate) fn unknown_surface_error(kind: SnapshotSurface) -> AdapterError {
    AdapterError::new(
        ErrorCode::PlatformNotSupported,
        format!(
            "'{}' is not a shell surface this adapter resolves",
            kebab(kind)
        ),
    )
    .with_disposition(DeliverySemantics::not_delivered())
}

/// The caller-facing answer for a shell surface that is simply not up right
/// now - distinct from a build refusal, which names the build, and from the
/// application-window "window not found", whose recovery guidance cannot work
/// for a surface no application owns. The suggestion names the command that
/// raises the surface, so an agent told the surface is closed also learns how
/// to open it.
pub(crate) fn not_open_error(kind: SnapshotSurface) -> AdapterError {
    AdapterError::new(
        ErrorCode::WindowNotFound,
        format!(
            "The '{}' shell surface is not open on this desktop",
            kebab(kind)
        ),
    )
    .with_suggestion(format!(
        "Run 'open-system-surface --surface {}' to raise it, then retry",
        kebab(kind)
    ))
    .with_disposition(DeliverySemantics::not_delivered())
}

/// The informative refusal for a kind this build does not expose: a bare
/// "not supported" cannot be told apart from "not implemented", so the detail
/// names the build and the surface that carries the capability instead.
pub(crate) fn refusal_error(row: &SurfaceKindRow) -> AdapterError {
    let holder = row.capability_holder.unwrap_or("an equivalent surface");
    AdapterError::new(
        ErrorCode::PlatformNotSupported,
        format!(
            "the running build does not expose the '{}' shell surface",
            kebab(row.kind)
        ),
    )
    .with_platform_detail(format!(
        "Windows build {} has no '{}' surface; the '{holder}' surface carries this capability on this build",
        build_number(),
        kebab(row.kind)
    ))
    .with_suggestion(format!("Use the '{holder}' surface instead"))
    .with_disposition(DeliverySemantics::not_delivered())
}

pub(in crate::system) fn kebab(kind: SnapshotSurface) -> String {
    kind.as_str().replace('_', "-")
}

pub(crate) fn build_number() -> u32 {
    #[cfg(target_os = "windows")]
    {
        #[repr(C)]
        struct VersionInfoW {
            size: u32,
            major: u32,
            minor: u32,
            build: u32,
            platform_id: u32,
            csd: [u16; 128],
        }
        #[link(name = "ntdll")]
        unsafe extern "system" {
            fn RtlGetVersion(info: *mut VersionInfoW) -> i32;
        }
        let mut info = VersionInfoW {
            size: std::mem::size_of::<VersionInfoW>() as u32,
            major: 0,
            minor: 0,
            build: 0,
            platform_id: 0,
            csd: [0; 128],
        };
        if unsafe { RtlGetVersion(&mut info) } == 0 {
            return info.build;
        }
        0
    }
    #[cfg(not(target_os = "windows"))]
    {
        0
    }
}

/// The resolver proper. The immersive liveness predicate is root membership
/// AND an uncloaked read (A26-2): after dismissal the window survives cloaked
/// with `IsWindowVisible` still true, and it has left the UIA root - so either
/// signal alone reads a dismissed surface as open, and the two are read
/// together.
#[cfg(target_os = "windows")]
fn resolve_present_row(row: &SurfaceKindRow) -> Result<Option<WindowInfo>, AdapterError> {
    match &row.family {
        SurfaceFamily::Win32Class(chain) => {
            Ok(resolve_class_chain(chain).and_then(window_info_from_chain_window))
        }
        SurfaceFamily::Immersive {
            expected_class,
            host_images,
            landmarks,
        } => super::shell_surface_immersive::resolve_immersive(
            expected_class,
            host_images,
            landmarks,
        ),
    }
}

#[cfg(not(target_os = "windows"))]
fn resolve_present_row(_row: &SurfaceKindRow) -> Result<Option<WindowInfo>, AdapterError> {
    Err(AdapterError::not_supported("resolve shell surface"))
}

#[cfg(target_os = "windows")]
fn resolve_class_chain(chain: &[&str]) -> Option<WindowHandle> {
    let mut current = find_window_by_class(None, chain.first()?)?;
    for class in &chain[1..] {
        current = find_window_by_class(Some(current), class)?;
    }
    let terminal = crate::system::window::window_ops::window_class_name(current);
    (terminal.as_deref() == chain.last().copied()).then_some(current)
}

#[cfg(target_os = "windows")]
fn find_window_by_class(parent: Option<WindowHandle>, class: &str) -> Option<WindowHandle> {
    use windows_sys::Win32::UI::WindowsAndMessaging::{FindWindowExW, FindWindowW};

    let wide = wide(class);
    let found = match parent {
        Some(parent) => unsafe {
            FindWindowExW(
                parent,
                std::ptr::null_mut(),
                wide.as_ptr(),
                std::ptr::null(),
            )
        },
        None => unsafe { FindWindowW(wide.as_ptr(), std::ptr::null()) },
    };
    if found.is_null() { None } else { Some(found) }
}

#[cfg(target_os = "windows")]
fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Builds the tray-family identity the same way the window listing does. The
/// taskbar family is owned by explorer, read off the exact window the chain
/// walked to; a window whose owning process cannot be read has no identity to
/// hand out, so it resolves as absent rather than as a half-identified entry.
#[cfg(target_os = "windows")]
fn window_info_from_chain_window(handle: WindowHandle) -> Option<WindowInfo> {
    use windows_sys::Win32::UI::WindowsAndMessaging::{IsIconic, IsWindowVisible};

    let pid = crate::system::window::window_identity::live_window_owner(handle)?;
    let image = crate::system::process_identity::process_image_name(pid).unwrap_or_default();
    let token = crate::system::process_identity::token_for_pid(pid)
        .ok()
        .flatten();
    Some(WindowInfo {
        id: crate::system::window::window_ops::window_id(handle),
        title: crate::system::window::window_identity::live_window_title(handle)
            .unwrap_or_default(),
        app: image,
        pid,
        process_instance: token,
        bounds: Some(crate::system::window::window_enum::window_rect(handle)),
        state: crate::system::window::window_ops::window_state(
            crate::system::window::window_ops::is_foreground_window(handle),
            unsafe { IsIconic(handle) } != 0,
            unsafe { IsWindowVisible(handle) } != 0,
        ),
    })
}

#[cfg(target_os = "windows")]
pub(in crate::system) fn shell_tray_handle() -> Option<WindowHandle> {
    resolve_class_chain(&["Shell_TrayWnd"])
}

/// The top-level window a class chain starts at - the half of the chain the
/// close path reads visibility from, since a chain's descendant toolbar stays
/// materialized after dismissal while its top-level window hides.
#[cfg(target_os = "windows")]
pub(in crate::system) fn class_chain_top_handle(chain: &[&str]) -> Option<WindowHandle> {
    find_window_by_class(None, chain.first()?)
}

#[cfg(all(test, target_os = "windows"))]
#[path = "shell_surface_tests.rs"]
mod tests;
