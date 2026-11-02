//! The positive arm of renderer detection, which needs a window whose real
//! Win32 class is the one the detector looks for.
//!
//! The negative arms in this file pin an unresolvable id and a live window of
//! some other class. Neither fails if the class constant is mistyped, because
//! both expect `None` and a constant that matches nothing still returns
//! `None`. That is precisely the
//! regression worth guarding - the CDP guidance stops being offered and no
//! test notices - so this registers a window class literally named
//! `Chrome_WidgetWin_1` and drives the same `parse_handle` ->
//! `window_class_name` -> compare path a real Chromium window would.
//!
//! The window is message-only: it is never shown, needs no message pump, and
//! `GetClassNameW` answers for it exactly as it does for a top-level window.

use agent_desktop_core::{ProcessId, RendererKind};
use windows_sys::Win32::Foundation::HWND;
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DestroyWindow, HWND_MESSAGE, WS_OVERLAPPED,
};

use crate::system::launch::detect_renderer_from_window;
use crate::tree::fixture::fixture_window::{register_class, unregister_class, wide};

const CHROMIUM_CLASS: &str = "Chrome_WidgetWin_1";

/// Owns the registered class and the window for the length of one test, so a
/// failed assertion cannot leave either behind for the next one.
struct ChromiumClassWindow {
    handle: HWND,
}

impl ChromiumClassWindow {
    fn create() -> Result<Self, String> {
        register_class(CHROMIUM_CLASS)?;
        let name = wide(CHROMIUM_CLASS);
        let title = wide("agent-desktop renderer probe");
        let handle = unsafe {
            CreateWindowExW(
                0,
                name.as_ptr(),
                title.as_ptr(),
                WS_OVERLAPPED,
                0,
                0,
                0,
                0,
                HWND_MESSAGE,
                std::ptr::null_mut(),
                GetModuleHandleW(std::ptr::null()),
                std::ptr::null(),
            )
        };
        if handle.is_null() {
            unregister_class(CHROMIUM_CLASS);
            return Err("CreateWindowExW produced no message-only window".into());
        }
        Ok(Self { handle })
    }

    fn window_id(&self) -> String {
        crate::system::window::window_ops::window_id(self.handle)
    }
}

impl Drop for ChromiumClassWindow {
    fn drop(&mut self) {
        unsafe { DestroyWindow(self.handle) };
        unregister_class(CHROMIUM_CLASS);
    }
}

fn window_info_for_id(id: &str) -> agent_desktop_core::WindowInfo {
    agent_desktop_core::WindowInfo {
        id: id.to_string(),
        title: String::new(),
        app: String::new(),
        pid: ProcessId::from(std::process::id()),
        process_instance: None,
        bounds: None,
        state: agent_desktop_core::WindowState::default(),
    }
}

#[test]
#[cfg(target_os = "windows")]
fn a_window_carrying_the_chromium_class_reports_the_chromium_renderer() {
    let Ok(window) = ChromiumClassWindow::create() else {
        panic!("the test host must be able to register a class and create a message-only window");
    };

    let observed = crate::system::window::window_ops::window_class_name(window.handle);
    assert_eq!(
        observed.as_deref(),
        Some(CHROMIUM_CLASS),
        "the probe window must actually carry the class the detector looks for, \
         or this test proves nothing about the comparison"
    );

    assert_eq!(
        detect_renderer_from_window(&window_info_for_id(&window.window_id())),
        Some(RendererKind::Chromium),
        "a window whose real Win32 class is the Chromium one must be reported as \
         Chromium; without this the class constant can be mistyped and the CDP \
         guidance silently stops being offered"
    );
}

/// The null-handle guard: an id `parse_handle` cannot resolve to a real
/// `HWND` must never reach `window_class_name`, whatever shape the id takes -
/// a string with no `w-` prefix at all, and a `w-` prefix whose number parses
/// but is the null handle itself.
#[cfg(target_os = "windows")]
#[test]
fn an_id_that_does_not_resolve_to_a_real_handle_reports_no_renderer() {
    assert!(detect_renderer_from_window(&window_info_for_id("not-a-window-id")).is_none());
    assert!(detect_renderer_from_window(&window_info_for_id("w-0")).is_none());
}

/// A genuine, live window whose class is not `Chrome_WidgetWin_1` must not be
/// reported as Chromium. The class is read independently first so the test
/// proves it is exercising the class-comparison branch, not merely a fixture
/// whose class happened to be unreadable.
#[cfg(target_os = "windows")]
#[test]
fn a_live_non_chromium_window_reports_no_renderer() {
    crate::tree::fixture::ensure_test_apartment();
    let fixture = crate::tree::fixture::LocalFixture::create().expect("fixture window");
    let id = format!("w-{}", fixture.handle() as usize);
    let handle = crate::system::window::window_ops::parse_handle(&id);
    let class = crate::system::window::window_ops::window_class_name(handle)
        .expect("a live fixture window reports its own window class");
    assert_ne!(
        class, "Chrome_WidgetWin_1",
        "the fixture's class must not already be the Chromium class this test rules out"
    );
    let window = window_info_for_id(&id);
    assert!(
        detect_renderer_from_window(&window).is_none(),
        "a live window whose class is not Chrome_WidgetWin_1 must not be reported as Chromium"
    );
}
