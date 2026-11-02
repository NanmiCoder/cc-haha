//! Menu fixture, plus the child-process plumbing `fixture_modal.rs` shares.
//!
//! Both fixtures are `HostedFixture`-style re-executed child processes,
//! driven entirely through window messages posted to the handle each reports
//! on stdout - `PostMessageW` routes across process boundaries, so no second
//! IPC channel is needed. A menu or a modal opened in the *test* process
//! would contaminate the predicate a later unit builds against it (a classic
//! Win32 menu puts the opening thread itself into menu mode), so both fixtures
//! live in a re-executed child rather than in-process.
//!
//! `TrackPopupMenu` runs its own nested message loop and blocks the pump
//! thread until dismissed, so open is posted rather than called inline. The
//! dismiss command is posted the same way and is itself dispatched by that
//! nested loop - Win32 modal loops still `DispatchMessage` anything that is
//! not menu-navigation input - where `EndMenu` legitimately ends the calling
//! thread's own active menu.
//!
//! The UP state is reported from `WM_ENTERMENULOOP`, which the OS sends only
//! once `TrackPopupMenu` has entered its modal loop, never from the open
//! command: reporting at the command lets a waiter observe UP while the menu
//! is still being created. A `TrackPopupMenu` that fails reports the OS error
//! instead, so a menu that never opened fails with its real reason.
//!
//! Split from the modal fixture (`fixture_modal.rs`) purely on the 400-line
//! file cap: the two together do not fit one file at this crate's density.

use std::cell::Cell;
use std::ffi::c_void;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Command};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{JoinHandle, spawn};
use std::time::{Duration, Instant};

use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    AppendMenuW, CreateMenu, CreatePopupMenu, CreateWindowExW, DefWindowProcW, DestroyMenu,
    DestroyWindow, DispatchMessageW, EndMenu, GetMessageW, HMENU, MF_STRING, MSG, PostMessageW,
    PostQuitMessage, SW_SHOWNOACTIVATE, SetMenu, ShowWindow, TPM_LEFTBUTTON, TrackPopupMenu,
    TranslateMessage, WM_CLOSE, WM_DESTROY, WM_ENTERMENULOOP, WS_OVERLAPPEDWINDOW,
};

use super::fixture_window;

const MENU_HOST_ENV: &str = "AGENT_DESKTOP_MENU_FIXTURE_HOST";
const MENU_HOST_TEST_NAME: &str =
    "tree::fixture::fixture_menu::tests::menu_fixture_host_process_entry";
const MENU_HANDLE_PREFIX: &str = "AGENT_DESKTOP_MENU_HWND=";
const MENU_STATE_UP: &str = "AGENT_DESKTOP_MENU_STATE=UP";
const MENU_STATE_DOWN: &str = "AGENT_DESKTOP_MENU_STATE=DOWN";
const MENU_STATE_FAILED_PREFIX: &str = "AGENT_DESKTOP_MENU_STATE=FAILED:";

pub(crate) const HOST_WATCHDOG_LIFETIME: Duration = Duration::from_secs(300);
pub(crate) const STATE_POLL: Duration = Duration::from_millis(25);
pub(crate) const TERMINATE_TIMEOUT: Duration = Duration::from_secs(5);

const WM_APP: u32 = 0x8000;
const WM_FIXTURE_OPEN_CONTEXT_MENU: u32 = WM_APP + 1;
const WM_FIXTURE_DISMISS_MENU: u32 = WM_APP + 2;

thread_local! {
    static MENU_BAR: Cell<HMENU> = const { Cell::new(std::ptr::null_mut()) };
    static MENU_POPUP: Cell<HMENU> = const { Cell::new(std::ptr::null_mut()) };
}

pub(crate) fn signal(line: impl std::fmt::Display) {
    println!("{line}");
    let _ = std::io::stdout().flush();
}

/// `(ex_style, style)` and `(x, y, width, height)` grouped so the call stays
/// within the project's five-parameter limit.
pub(crate) fn create_window(
    styles: (u32, u32),
    class_name: &[u16],
    title: &str,
    geometry: (i32, i32, i32, i32),
    owner: HWND,
) -> HWND {
    let (ex_style, style) = styles;
    let (x, y, width, height) = geometry;
    let title = fixture_window::wide(title);
    unsafe {
        CreateWindowExW(
            ex_style,
            class_name.as_ptr(),
            title.as_ptr(),
            style,
            x,
            y,
            width,
            height,
            owner,
            std::ptr::null_mut(),
            GetModuleHandleW(std::ptr::null()),
            std::ptr::null(),
        )
    }
}

pub(crate) fn pump_until_quit() {
    let mut message = MSG::default();
    while unsafe { GetMessageW(&mut message, std::ptr::null_mut(), 0, 0) } > 0 {
        unsafe {
            TranslateMessage(&message);
            DispatchMessageW(&message);
        }
    }
}

pub(crate) fn post_message(handle: isize, message: u32) {
    unsafe { PostMessageW(handle as *mut c_void, message, 0, 0) };
}

pub(crate) fn wait_with_timeout(child: &mut Child, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        match child.try_wait() {
            Ok(Some(_)) => return true,
            Ok(None) => std::thread::sleep(Duration::from_millis(25)),
            Err(_) => return false,
        }
    }
    false
}

pub(crate) fn wait_for(flag: &AtomicBool, want: bool, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if flag.load(Ordering::SeqCst) == want {
            return true;
        }
        std::thread::sleep(STATE_POLL);
    }
    flag.load(Ordering::SeqCst) == want
}

pub(crate) fn run_with_watchdog(host: fn()) {
    spawn(|| {
        std::thread::sleep(HOST_WATCHDOG_LIFETIME);
        std::process::exit(0);
    });
    host();
}

fn destroy_menu_if_any(cell: &Cell<HMENU>) {
    let handle = cell.get();
    if !handle.is_null() {
        unsafe { DestroyMenu(handle) };
        cell.set(std::ptr::null_mut());
    }
}

fn build_menus(window: HWND) {
    let bar = unsafe { CreateMenu() };
    let bar_label = fixture_window::wide("fixture-menu-bar");
    unsafe {
        AppendMenuW(bar, MF_STRING, 1, bar_label.as_ptr());
        SetMenu(window, bar);
    }
    MENU_BAR.with(|cell| cell.set(bar));

    let popup = unsafe { CreatePopupMenu() };
    for index in 0..CONTEXT_MENU_ITEM_COUNT {
        let item_label = fixture_window::wide(&format!("fixture-menu-item-{index}"));
        unsafe { AppendMenuW(popup, MF_STRING, 2 + index, item_label.as_ptr()) };
    }
    MENU_POPUP.with(|cell| cell.set(popup));
}

/// How many items the context menu is staged with. Assertions count the
/// surface inventory against this constant rather than a literal, so a
/// fixture change cannot let a count assertion pass vacuously.
pub(crate) const CONTEXT_MENU_ITEM_COUNT: usize = 1;

fn open_context_menu(window: HWND) {
    let popup = MENU_POPUP.with(Cell::get);
    if popup.is_null() {
        return;
    }
    let shown = unsafe { TrackPopupMenu(popup, TPM_LEFTBUTTON, 0, 0, 0, window, std::ptr::null()) };
    if shown == 0 {
        signal(format_args!(
            "{MENU_STATE_FAILED_PREFIX}{}",
            std::io::Error::last_os_error()
        ));
    }
    signal(MENU_STATE_DOWN);
}

unsafe extern "system" fn menu_window_proc(
    window: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    match message {
        WM_FIXTURE_OPEN_CONTEXT_MENU => {
            open_context_menu(window);
            0
        }
        WM_FIXTURE_DISMISS_MENU => {
            unsafe { EndMenu() };
            0
        }
        WM_ENTERMENULOOP => {
            if wparam != 0 {
                signal(MENU_STATE_UP);
            }
            0
        }
        WM_CLOSE => {
            unsafe {
                EndMenu();
                DestroyWindow(window);
            }
            0
        }
        WM_DESTROY => {
            MENU_POPUP.with(destroy_menu_if_any);
            MENU_BAR.with(destroy_menu_if_any);
            unsafe { PostQuitMessage(0) };
            0
        }
        _ => unsafe { DefWindowProcW(window, message, wparam, lparam) },
    }
}

fn host_menu_window() {
    let class_name = fixture_window::unique_class_name();
    if fixture_window::register_class_with_proc(&class_name, menu_window_proc).is_err() {
        return;
    }
    let name = fixture_window::wide(&class_name);
    let stage = fixture_window::offscreen_stage();
    let (left, top) = stage.origin();
    let geometry = (
        left,
        top,
        fixture_window::WINDOW_WIDTH,
        fixture_window::WINDOW_HEIGHT,
    );
    let window = create_window(
        (0, WS_OVERLAPPEDWINDOW),
        &name,
        "agent-desktop menu fixture",
        geometry,
        std::ptr::null_mut(),
    );
    if window.is_null() {
        return;
    }
    build_menus(window);
    unsafe { ShowWindow(window, SW_SHOWNOACTIVATE) };
    signal(format_args!("{MENU_HANDLE_PREFIX}{}", window as isize));
    pump_until_quit();
    fixture_window::unregister_class(&class_name);
}

pub(crate) fn is_menu_fixture_host_process() -> bool {
    std::env::var(MENU_HOST_ENV).is_ok()
}

pub(crate) fn run_menu_fixture_as_host() {
    run_with_watchdog(host_menu_window);
}

/// A child process owning a real Win32 menu bar and a context menu, opened
/// and dismissed on command.
pub(crate) struct MenuFixture {
    child: Option<Child>,
    handle: isize,
    up: Arc<AtomicBool>,
    open_failure: Arc<Mutex<Option<String>>>,
    reader: Option<JoinHandle<()>>,
}

impl MenuFixture {
    pub(crate) fn spawn() -> Result<Self, String> {
        let executable = std::env::current_exe().map_err(|error| error.to_string())?;
        let mut command = Command::new(executable);
        command
            .args(["--exact", MENU_HOST_TEST_NAME, "--ignored", "--nocapture"])
            .env(MENU_HOST_ENV, "1");
        let up = Arc::new(AtomicBool::new(false));
        let up_writer = up.clone();
        let open_failure = Arc::new(Mutex::new(None));
        let failure_writer = open_failure.clone();
        let (child, handle, reader) = super::fixture_spawn::spawn_host(
            command,
            move |stdout, sender| {
                let mut announced = false;
                for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                    let line = line.trim();
                    if !announced {
                        if let Some(value) = line.strip_prefix(MENU_HANDLE_PREFIX) {
                            announced = true;
                            let _ = sender.send(Some(value.trim().parse::<isize>().unwrap_or(0)));
                            continue;
                        }
                    }
                    if line == MENU_STATE_UP {
                        up_writer.store(true, Ordering::SeqCst);
                    } else if line == MENU_STATE_DOWN {
                        up_writer.store(false, Ordering::SeqCst);
                    } else if let Some(reason) = line.strip_prefix(MENU_STATE_FAILED_PREFIX) {
                        *failure_writer
                            .lock()
                            .unwrap_or_else(|poisoned| poisoned.into_inner()) =
                            Some(reason.to_owned());
                    }
                }
                if !announced {
                    let _ = sender.send(None);
                }
            },
            |handle| *handle != 0,
            "the menu fixture host exposed no stdout",
            "the menu fixture host never reported a window handle",
        )?;
        Ok(Self {
            child: Some(child),
            handle,
            up,
            open_failure,
            reader: Some(reader),
        })
    }

    pub(crate) fn handle(&self) -> isize {
        self.handle
    }

    pub(crate) fn process_id(&self) -> u32 {
        self.child.as_ref().map(Child::id).unwrap_or_default()
    }

    pub(crate) fn menu_is_up(&self) -> bool {
        self.up.load(Ordering::SeqCst)
    }

    /// Waits for the fixture's reported state. `true` means the OS has put
    /// the fixture's thread into the popup's modal loop, not merely that the
    /// open command was received; a context menu the OS refused to show
    /// panics with that OS error rather than timing out silently.
    pub(crate) fn wait_for_menu_state(&self, want: bool, timeout: Duration) -> bool {
        let reached = wait_for(&self.up, want, timeout);
        if !reached && want {
            let failure = self
                .open_failure
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .clone();
            if let Some(reason) = failure {
                panic!("the menu fixture's TrackPopupMenu failed to show the menu: {reason}");
            }
        }
        reached
    }

    pub(crate) fn open_context_menu(&self) {
        post_message(self.handle, WM_FIXTURE_OPEN_CONTEXT_MENU);
    }

    pub(crate) fn dismiss_context_menu(&self) {
        post_message(self.handle, WM_FIXTURE_DISMISS_MENU);
    }
}

impl Drop for MenuFixture {
    fn drop(&mut self) {
        if let Some(mut child) = self.child.take() {
            post_message(self.handle, WM_CLOSE);
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
#[path = "fixture_menu_tests.rs"]
mod tests;
