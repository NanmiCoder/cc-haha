//! Modal-dialog fixture. Split from `fixture_menu.rs` purely on the 400-line
//! file cap - see that file's module doc for the shared child-process
//! plumbing (`signal`, `create_window`, `post_message`, ...) this file reuses
//! rather than duplicates.
//!
//! The fixture is an owned, `WS_EX_DLGMODALFRAME` window opened and closed on
//! command, carrying no title a test asserts on: the AE6 analog it exists for
//! must prove discovery without naming.

use std::cell::Cell;
use std::io::{BufRead, BufReader};
use std::process::{Child, Command};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread::JoinHandle;
use std::time::Duration;

use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::EnableWindow;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    DefWindowProcW, DestroyWindow, PostQuitMessage, SW_HIDE, SW_SHOW, SW_SHOWNOACTIVATE,
    ShowWindow, WM_CLOSE, WM_DESTROY, WS_CAPTION, WS_EX_DLGMODALFRAME, WS_OVERLAPPEDWINDOW,
    WS_POPUP, WS_SYSMENU,
};

use super::fixture_menu::{
    TERMINATE_TIMEOUT, create_window, post_message, pump_until_quit, signal, wait_for,
    wait_with_timeout,
};
use super::fixture_window;

const MODAL_HOST_ENV: &str = "AGENT_DESKTOP_MODAL_FIXTURE_HOST";
const MODAL_HOST_TEST_NAME: &str =
    "tree::fixture::fixture_modal::tests::modal_fixture_host_process_entry";
const MODAL_HANDLE_PREFIX: &str = "AGENT_DESKTOP_MODAL_HWND=";
const MODAL_STATE_UP: &str = "AGENT_DESKTOP_MODAL_STATE=UP";
const MODAL_STATE_DOWN: &str = "AGENT_DESKTOP_MODAL_STATE=DOWN";

const WM_APP: u32 = 0x8000;
const WM_FIXTURE_OPEN_MODAL: u32 = WM_APP + 1;
const WM_FIXTURE_CLOSE_MODAL: u32 = WM_APP + 2;

thread_local! {
    static MODAL_WINDOW: Cell<HWND> = const { Cell::new(std::ptr::null_mut()) };
}

fn open_modal(owner: HWND) {
    let modal = MODAL_WINDOW.with(Cell::get);
    if modal.is_null() {
        return;
    }
    unsafe {
        EnableWindow(owner, 0);
        ShowWindow(modal, SW_SHOW);
    }
    signal(MODAL_STATE_UP);
}

fn close_modal(owner: HWND) {
    let modal = MODAL_WINDOW.with(Cell::get);
    if !modal.is_null() {
        unsafe { ShowWindow(modal, SW_HIDE) };
    }
    unsafe { EnableWindow(owner, 1) };
    signal(MODAL_STATE_DOWN);
}

unsafe extern "system" fn modal_owner_proc(
    window: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    match message {
        WM_FIXTURE_OPEN_MODAL => {
            open_modal(window);
            0
        }
        WM_FIXTURE_CLOSE_MODAL => {
            close_modal(window);
            0
        }
        WM_CLOSE => {
            close_modal(window);
            unsafe { DestroyWindow(window) };
            0
        }
        WM_DESTROY => {
            let modal = MODAL_WINDOW.with(Cell::get);
            if !modal.is_null() {
                unsafe { DestroyWindow(modal) };
            }
            unsafe { PostQuitMessage(0) };
            0
        }
        _ => unsafe { DefWindowProcW(window, message, wparam, lparam) },
    }
}

fn host_modal_windows() {
    let class_name = fixture_window::unique_class_name();
    if fixture_window::register_class_with_proc(&class_name, modal_owner_proc).is_err() {
        return;
    }
    let name = fixture_window::wide(&class_name);
    let stage = fixture_window::offscreen_stage();
    let (left, top) = stage.origin();
    let owner = create_window(
        (0, WS_OVERLAPPEDWINDOW),
        &name,
        "agent-desktop modal fixture owner",
        (
            left,
            top,
            fixture_window::WINDOW_WIDTH,
            fixture_window::WINDOW_HEIGHT,
        ),
        std::ptr::null_mut(),
    );
    if owner.is_null() {
        return;
    }
    let modal = create_window(
        (WS_EX_DLGMODALFRAME, WS_POPUP | WS_CAPTION | WS_SYSMENU),
        &name,
        "agent-desktop modal fixture modal",
        (left + 40, top + 40, 240, 120),
        owner,
    );
    if modal.is_null() {
        return;
    }
    MODAL_WINDOW.with(|cell| cell.set(modal));
    unsafe { ShowWindow(owner, SW_SHOWNOACTIVATE) };
    signal(format_args!("{MODAL_HANDLE_PREFIX}{}", owner as isize));
    signal(format_args!("{MODAL_HANDLE_PREFIX}{}", modal as isize));
    pump_until_quit();
    fixture_window::unregister_class(&class_name);
}

pub(crate) fn is_modal_fixture_host_process() -> bool {
    std::env::var(MODAL_HOST_ENV).is_ok()
}

pub(crate) fn run_modal_fixture_as_host() {
    super::fixture_menu::run_with_watchdog(host_modal_windows);
}

/// A child process owning an owned, `WS_EX_DLGMODALFRAME` modal window,
/// opened and closed on command. Carries no title a test asserts on.
pub(crate) struct ModalFixture {
    child: Option<Child>,
    owner: isize,
    modal: isize,
    up: Arc<AtomicBool>,
    reader: Option<JoinHandle<()>>,
}

impl ModalFixture {
    pub(crate) fn spawn() -> Result<Self, String> {
        let executable = std::env::current_exe().map_err(|error| error.to_string())?;
        let mut command = Command::new(executable);
        command
            .args(["--exact", MODAL_HOST_TEST_NAME, "--ignored", "--nocapture"])
            .env(MODAL_HOST_ENV, "1");
        let up = Arc::new(AtomicBool::new(false));
        let up_writer = up.clone();
        let (child, (owner, modal), reader) = super::fixture_spawn::spawn_host(
            command,
            move |stdout, sender| {
                let mut handles = Vec::new();
                for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                    let line = line.trim();
                    if handles.len() < 2 {
                        if let Some(value) = line.strip_prefix(MODAL_HANDLE_PREFIX) {
                            handles.push(value.trim().parse::<isize>().unwrap_or(0));
                            if handles.len() == 2 {
                                let _ = sender.send(Some((handles[0], handles[1])));
                            }
                            continue;
                        }
                    }
                    if line == MODAL_STATE_UP {
                        up_writer.store(true, Ordering::SeqCst);
                    } else if line == MODAL_STATE_DOWN {
                        up_writer.store(false, Ordering::SeqCst);
                    }
                }
                if handles.len() < 2 {
                    let _ = sender.send(None);
                }
            },
            |handles: &(isize, isize)| handles.0 != 0 && handles.1 != 0,
            "the modal fixture host exposed no stdout",
            "the modal fixture host never reported its window handles",
        )?;
        Ok(Self {
            child: Some(child),
            owner,
            modal,
            up,
            reader: Some(reader),
        })
    }

    pub(crate) fn owner_handle(&self) -> isize {
        self.owner
    }

    pub(crate) fn modal_handle(&self) -> isize {
        self.modal
    }

    pub(crate) fn process_id(&self) -> u32 {
        self.child.as_ref().map(Child::id).unwrap_or_default()
    }

    pub(crate) fn modal_is_up(&self) -> bool {
        self.up.load(Ordering::SeqCst)
    }

    pub(crate) fn wait_for_modal_state(&self, want: bool, timeout: Duration) -> bool {
        wait_for(&self.up, want, timeout)
    }

    pub(crate) fn open(&self) {
        post_message(self.owner, WM_FIXTURE_OPEN_MODAL);
    }

    pub(crate) fn close(&self) {
        post_message(self.owner, WM_FIXTURE_CLOSE_MODAL);
    }
}

impl Drop for ModalFixture {
    fn drop(&mut self) {
        if let Some(mut child) = self.child.take() {
            post_message(self.owner, WM_CLOSE);
            if !wait_with_timeout(&mut child, TERMINATE_TIMEOUT) {
                super::fixture_spawn::kill_and_wait(&mut child);
            }
        }
        if let Some(reader) = self.reader.take() {
            let _ = reader.join();
        }
    }
}

#[cfg(test)]
#[path = "fixture_modal_tests.rs"]
mod tests;
