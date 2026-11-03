use std::ffi::c_void;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc::Sender;

use super::fixture_overlay;

use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows_sys::Win32::System::ApplicationInstallationAndServicing::{
    ACTCTXW, ActivateActCtx, CreateActCtxW,
};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::System::Threading::GetCurrentThreadId;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetMessageW, GetWindowRect,
    IDC_ARROW, IsWindowVisible, LoadCursorW, MSG, PostMessageW, PostQuitMessage,
    PostThreadMessageW, RegisterClassExW, SW_MINIMIZE, SW_SHOWNOACTIVATE, SetWindowTextW,
    ShowWindow, TranslateMessage, UnregisterClassW, WM_CLOSE, WM_DESTROY, WM_QUIT, WNDCLASSEXW,
    WS_CHILD, WS_OVERLAPPEDWINDOW, WS_VISIBLE,
};

const ES_PASSWORD: u32 = 0x0020;
/// Private message posted before the pump so readiness is announced from inside it.
///
/// `ElementFromHandle` sends `WM_GETOBJECT` and a cross-thread `SendMessage`
/// blocks until the receiving thread dispatches, so a handle announced before
/// the pump starts lets a loaded machine call in during the gap and observe
/// `E_FAIL`.
const WM_FIXTURE_READY: u32 = 0x0400 + 1;
const CONTROL_BORDER: u32 = 0x0080_0000;
pub(crate) const WINDOW_WIDTH: i32 = 420;
pub(crate) const WINDOW_HEIGHT: i32 = 320;

pub(crate) use crate::tree::fixture::offscreen_origin::{on_screen_origin, on_screen_stage};

/// The `comctl32` v6 side-by-side manifest. Without an activation context the
/// v5 common controls are bound, and the standard controls the fixture creates
/// do not get their full UI Automation support.
const COMCTL32_V6_MANIFEST: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <dependency>
    <dependentAssembly>
      <assemblyIdentity type="win32" name="Microsoft.Windows.Common-Controls"
        version="6.0.0.0" processorArchitecture="*" publicKeyToken="6595b64144ccf1df"
        language="*" />
    </dependentAssembly>
  </dependency>
</assembly>
"#;

/// Text written into the fixture's `ES_PASSWORD` control. A read outcome that
/// contains this string has leaked secure content.
pub(crate) const SECURE_MARKER: &str = "zzfixturesecretzz";

/// Text written into the fixture's plain `EDIT` control, so a redaction test
/// has a value that a failing read could plausibly carry into an error.
pub(crate) const CONTENT_MARKER: &str = "zzfixturecontentzz";

static CLASS_SEQUENCE: AtomicU32 = AtomicU32::new(0);

/// Names the control the fixture creates so a test can select it by role
/// without matching on a localized string.
pub(crate) struct FixtureControls {
    pub(crate) button: HWND,
    pub(crate) edit: HWND,
    pub(crate) password: HWND,
}

/// A running fixture pump: the window it owns and the thread that pumps it.
#[derive(Debug, Clone, Copy)]
pub(crate) struct PumpHandle {
    pub(crate) window: isize,
    pub(crate) thread_id: u32,
}

pub(crate) struct WindowGeometry {
    pub(crate) visible: bool,
    pub(crate) width: i32,
    pub(crate) height: i32,
}

pub(crate) fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Mints a class name unique to this process and call.
///
/// `RegisterClassExW` fails with `ERROR_CLASS_ALREADY_EXISTS` when a second
/// fixture re-registers the same name, and the test binary runs its cases in
/// parallel threads, so a shared name would make concurrent fixtures race.
pub(crate) fn unique_class_name() -> String {
    let sequence = CLASS_SEQUENCE.fetch_add(1, Ordering::SeqCst);
    format!("AgentDesktopFixture-{}-{}", std::process::id(), sequence)
}

unsafe extern "system" fn window_proc(
    window: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    if message == WM_CLOSE && swallow_wm_close() {
        return 0;
    }
    if message == WM_DESTROY {
        unsafe { PostQuitMessage(0) };
        return 0;
    }
    if message == fixture_overlay::STAGE_OVERLAY_MESSAGE {
        fixture_overlay::show_overlay_child(window);
        return 0;
    }
    unsafe { DefWindowProcW(window, message, wparam, lparam) }
}

fn swallow_wm_close() -> bool {
    std::env::var_os(crate::tree::fixture::SWALLOW_WM_CLOSE_FLAG).is_some()
}

fn activate_common_controls_v6() {
    static ACTIVATED: std::sync::Once = std::sync::Once::new();
    ACTIVATED.call_once(install_common_controls_v6);
}

/// The activation context is process-wide, so writing the manifest and
/// creating the context once per fixture wrote the same file repeatedly and
/// leaked a context per window.
fn install_common_controls_v6() {
    let directory = std::env::temp_dir().join("agent-desktop-fixture-manifests");
    let _ = std::fs::create_dir_all(&directory);
    let path = directory.join(format!("comctl32-v6-{}.manifest", std::process::id()));
    if std::fs::write(&path, COMCTL32_V6_MANIFEST).is_err() {
        return;
    }
    let source = wide(&path.to_string_lossy());
    let context = ACTCTXW {
        cbSize: size_of::<ACTCTXW>() as u32,
        lpSource: source.as_ptr(),
        ..Default::default()
    };
    let handle = unsafe { CreateActCtxW(&context) };
    if !handle.is_null() && handle as isize != -1 {
        let mut cookie = 0usize;
        unsafe { ActivateActCtx(handle, &mut cookie) };
    }
}

pub(crate) type WndProc = unsafe extern "system" fn(HWND, u32, WPARAM, LPARAM) -> LRESULT;

pub(crate) fn register_class(class_name: &str) -> Result<(), String> {
    register_class_with_proc(class_name, window_proc)
}

pub(crate) fn register_class_with_proc(class_name: &str, proc: WndProc) -> Result<(), String> {
    let name = wide(class_name);
    let class = WNDCLASSEXW {
        cbSize: size_of::<WNDCLASSEXW>() as u32,
        lpfnWndProc: Some(proc),
        hInstance: unsafe { GetModuleHandleW(std::ptr::null()) },
        hCursor: unsafe { LoadCursorW(std::ptr::null_mut(), IDC_ARROW) },
        lpszClassName: name.as_ptr(),
        ..Default::default()
    };
    if unsafe { RegisterClassExW(&class) } == 0 {
        return Err(format!("RegisterClassExW rejected the class {class_name}"));
    }
    Ok(())
}

pub(crate) fn unregister_class(class_name: &str) {
    let name = wide(class_name);
    unsafe {
        UnregisterClassW(name.as_ptr(), GetModuleHandleW(std::ptr::null()));
    }
}

fn control(parent: HWND, class: &str, text: &str, style: u32, top: i32) -> HWND {
    let class = wide(class);
    let text = wide(text);
    unsafe {
        CreateWindowExW(
            0,
            class.as_ptr(),
            text.as_ptr(),
            WS_CHILD | style,
            8,
            top,
            200,
            24,
            parent,
            std::ptr::null_mut(),
            GetModuleHandleW(std::ptr::null()),
            std::ptr::null(),
        )
    }
}

pub(crate) fn host_window(class_name: &str, ready: Sender<Result<PumpHandle, String>>) {
    let stage = offscreen_stage();
    let (left, top) = stage.origin();
    host_window_at(class_name, ready, left, top);
}

/// Resolves where the default fixture window should park: off-screen when
/// the live virtual-screen rect leaves room, the serialized on-screen stage
/// otherwise. The returned `Stage` must be held for as long as the fixture
/// window it parks is alive.
pub(crate) fn offscreen_stage() -> crate::tree::fixture::offscreen_origin::Stage {
    crate::tree::fixture::offscreen_origin::stage(None, WINDOW_WIDTH, WINDOW_HEIGHT)
}

/// Creates the fixture window at a caller-chosen origin, then pumps until
/// destroyed. Live hit-test legs need an origin inside the virtual screen
/// rect; the default off-screen parking resolves against the live
/// virtual-screen rect rather than a box-sized constant (A18-6).
pub(crate) fn host_window_at(
    class_name: &str,
    ready: Sender<Result<PumpHandle, String>>,
    left: i32,
    top: i32,
) {
    activate_common_controls_v6();
    if let Err(error) = register_class(class_name) {
        let _ = ready.send(Err(error));
        return;
    }
    let name = wide(class_name);
    let title = wide("agent-desktop fixture");
    let window = unsafe {
        CreateWindowExW(
            0,
            name.as_ptr(),
            title.as_ptr(),
            WS_OVERLAPPEDWINDOW,
            left,
            top,
            WINDOW_WIDTH,
            WINDOW_HEIGHT,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            GetModuleHandleW(std::ptr::null()),
            std::ptr::null(),
        )
    };
    if window.is_null() {
        let _ = ready.send(Err("CreateWindowExW produced no window".into()));
        return;
    }
    let controls = create_controls(window);
    debug_assert!(!controls.button.is_null());
    debug_assert!(!controls.edit.is_null());
    debug_assert!(!controls.password.is_null());
    unsafe { ShowWindow(window, SW_SHOWNOACTIVATE) };
    unsafe { PostMessageW(window, WM_FIXTURE_READY, 0, 0) };
    pump_until_destroyed(window as isize, ready, WM_FIXTURE_READY);
}

/// Locates the fixture's primary `BUTTON` by its window text.
pub(crate) fn find_button(parent: isize) -> *mut c_void {
    use windows_sys::Win32::UI::WindowsAndMessaging::FindWindowExW;
    let class = wide("BUTTON");
    let text = wide("fixture-button");
    unsafe {
        FindWindowExW(
            parent as *mut c_void,
            std::ptr::null_mut(),
            class.as_ptr(),
            text.as_ptr(),
        )
    }
}

fn create_controls(window: HWND) -> FixtureControls {
    let button = control(
        window,
        "BUTTON",
        "fixture-button",
        WS_VISIBLE | CONTROL_BORDER,
        8,
    );
    control(window, "STATIC", "fixture-static", WS_VISIBLE, 40);
    let edit = control(
        window,
        "EDIT",
        CONTENT_MARKER,
        WS_VISIBLE | CONTROL_BORDER,
        72,
    );
    let password = control(
        window,
        "EDIT",
        "",
        WS_VISIBLE | CONTROL_BORDER | ES_PASSWORD,
        104,
    );
    let secret = wide(SECURE_MARKER);
    unsafe { SetWindowTextW(password, secret.as_ptr()) };
    let _overlay = fixture_overlay::create_hidden_overlay(window);
    FixtureControls {
        button,
        edit,
        password,
    }
}

pub(crate) fn pump_until_destroyed(
    handle: isize,
    ready: Sender<Result<PumpHandle, String>>,
    ready_message: u32,
) {
    let thread_id = unsafe { GetCurrentThreadId() };
    let mut message = MSG::default();
    let mut announced = false;
    while unsafe { GetMessageW(&mut message, std::ptr::null_mut(), 0, 0) } > 0 {
        unsafe { TranslateMessage(&message) };
        unsafe { DispatchMessageW(&message) };
        if !announced && message.message == ready_message {
            announced = true;
            let _ = ready.send(Ok(PumpHandle {
                window: handle,
                thread_id,
            }));
        }
    }
}

pub(crate) fn close_window(handle: isize) {
    unsafe { PostMessageW(handle as *mut c_void, WM_CLOSE, 0, 0) };
}

/// Ends a pump whose window may already be gone.
///
/// `WM_CLOSE` reaches the pump only through the window, so a window destroyed
/// out from under the fixture leaves `GetMessageW` blocked forever and turns a
/// joining teardown into a hang of the whole test binary rather than a
/// failure. `WM_QUIT` is posted to the *thread* queue, which `GetMessageW`
/// answers with 0 whatever the window's state.
pub(crate) fn quit_pump(thread_id: u32) {
    unsafe { PostThreadMessageW(thread_id, WM_QUIT, 0, 0) };
}

pub(crate) fn minimize_window(handle: isize) {
    unsafe { ShowWindow(handle as *mut c_void, SW_MINIMIZE) };
}

pub(crate) fn destroy_window(handle: isize) {
    unsafe { DestroyWindow(handle as *mut c_void) };
}

pub(crate) fn geometry(handle: isize) -> WindowGeometry {
    let window = handle as *mut c_void;
    let mut rect = RECT {
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
    };
    let read = unsafe { GetWindowRect(window, &mut rect) };
    WindowGeometry {
        visible: unsafe { IsWindowVisible(window) } != 0,
        width: if read != 0 { rect.right - rect.left } else { 0 },
        height: if read != 0 { rect.bottom - rect.top } else { 0 },
    }
}
