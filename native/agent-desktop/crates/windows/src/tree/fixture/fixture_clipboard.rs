use std::io::Write;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Sender, channel};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread::{JoinHandle, spawn};
use std::time::Duration;

use windows_sys::Win32::Foundation::{GetLastError, HWND, SetLastError};
use windows_sys::Win32::System::DataExchange::{
    CloseClipboard, EmptyClipboard, GetClipboardOwner, GetOpenClipboardWindow,
    IsClipboardFormatAvailable, OpenClipboard, SetClipboardData,
};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DestroyWindow, HWND_MESSAGE, SW_SHOWNOACTIVATE, ShowWindow,
    WS_OVERLAPPEDWINDOW,
};

use super::fixture_spawn;
use super::fixture_window;

const CF_UNICODETEXT: u32 = 13;
const HOST_ENVIRONMENT_FLAG: &str = "AGENT_DESKTOP_CLIPBOARD_HOLDER_HOST";
const HOST_TEST_NAME: &str =
    "tree::fixture::fixture_clipboard::tests::clipboard_holder_host_process_entry";
const READY_PREFIX: &str = "AGENT_DESKTOP_CLIPBOARD_HOLDER_READY";
const READY_TIMEOUT: Duration = Duration::from_secs(30);
const STALL_POLL: Duration = Duration::from_millis(25);
const OPEN_CLIPBOARD_PATIENCE: Duration = Duration::from_secs(10);
const OPEN_CLIPBOARD_POLL: Duration = Duration::from_millis(10);

/// Process-wide lock for every test that touches the real clipboard (A22-5).
pub(crate) fn clipboard_test_lock() -> MutexGuard<'static, ()> {
    static LOCK: Mutex<()> = Mutex::new(());
    LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Delay-rendering clipboard owner that stops pumping after advertising.
///
/// Takes ownership, publishes `SetClipboardData(CF_UNICODETEXT, NULL)`, then
/// never dispatches — the shape that makes delayed `GetClipboardData` hang
/// unboundedly (A22-3).
pub(crate) struct DelayedClipboardOwner {
    handle: isize,
    class_name: String,
    stop: Arc<AtomicBool>,
    host: Option<JoinHandle<()>>,
}

impl DelayedClipboardOwner {
    pub(crate) fn create() -> Result<Self, String> {
        let class_name = fixture_window::unique_class_name();
        let stop = Arc::new(AtomicBool::new(false));
        let (sender, receiver) = channel();
        let host = spawn({
            let class_name = class_name.clone();
            let stop = stop.clone();
            move || delayed_owner_thread(&class_name, sender, stop)
        });
        match receiver.recv_timeout(READY_TIMEOUT) {
            Ok(Ok(handle)) => Ok(Self {
                handle,
                class_name,
                stop,
                host: Some(host),
            }),
            Ok(Err(error)) => Err(error),
            Err(_) => {
                stop.store(true, Ordering::SeqCst);
                Err(String::from(
                    "the delayed clipboard owner never became ready",
                ))
            }
        }
    }

    pub(crate) fn handle(&self) -> isize {
        self.handle
    }

    pub(crate) fn format_available(&self) -> bool {
        unsafe { IsClipboardFormatAvailable(CF_UNICODETEXT) != 0 }
    }

    pub(crate) fn owner_is_self(&self) -> bool {
        unsafe { GetClipboardOwner() as isize == self.handle }
    }
}

impl Drop for DelayedClipboardOwner {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(host) = self.host.take() {
            let _ = host.join();
        }
        fixture_window::unregister_class(&self.class_name);
        clear_clipboard_best_effort();
    }
}

/// Second-process holder that keeps `OpenClipboard` until released.
pub(crate) struct ContendingClipboardHolder {
    child: Option<Child>,
}

impl ContendingClipboardHolder {
    pub(crate) fn spawn() -> Result<Self, String> {
        let executable = std::env::current_exe().map_err(|error| error.to_string())?;
        let mut command = Command::new(executable);
        command
            .args(["--exact", HOST_TEST_NAME, "--ignored", "--nocapture"])
            .env(HOST_ENVIRONMENT_FLAG, "1")
            .stdin(Stdio::piped());
        let (child, _, _reader) = fixture_spawn::spawn_host(
            command,
            fixture_spawn::first_line(|line| (line == READY_PREFIX).then_some(true)),
            |ready| *ready,
            "the clipboard holder exposed no stdout",
            "the clipboard holder never reported readiness",
        )?;
        Ok(Self { child: Some(child) })
    }

    pub(crate) fn process_id(&self) -> u32 {
        self.child.as_ref().map(Child::id).unwrap_or_default()
    }

    pub(crate) fn open_clipboard_window(&self) -> isize {
        unsafe { GetOpenClipboardWindow() as isize }
    }

    pub(crate) fn release(&mut self) -> Result<(), String> {
        let Some(mut child) = self.child.take() else {
            return Ok(());
        };
        request_holder_release(&mut child);
        await_holder_exit(&mut child)
    }
}

impl Drop for ContendingClipboardHolder {
    fn drop(&mut self) {
        if let Some(mut child) = self.child.take() {
            request_holder_release(&mut child);
            let _ = await_holder_exit(&mut child);
        }
    }
}

fn request_holder_release(child: &mut Child) {
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(b"release\n");
        let _ = stdin.flush();
    }
}

fn await_holder_exit(child: &mut Child) -> Result<(), String> {
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => return Ok(()),
            Ok(Some(status)) => {
                return Err(format!("clipboard holder exited unsuccessfully: {status}"));
            }
            Ok(None) if std::time::Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(25));
            }
            Ok(None) => {
                fixture_spawn::kill_and_wait(child);
                return Err(String::from("clipboard holder did not exit after release"));
            }
            Err(error) => {
                fixture_spawn::kill_and_wait(child);
                return Err(error.to_string());
            }
        }
    }
}

pub(crate) fn is_clipboard_holder_host() -> bool {
    std::env::var(HOST_ENVIRONMENT_FLAG).is_ok()
}

pub(crate) fn run_as_clipboard_holder_host() {
    super::fixture_menu::run_with_watchdog(host_clipboard_holder);
}

fn host_clipboard_holder() {
    let code = match hold_clipboard_until_release() {
        Ok(()) => 0,
        Err(_) => 2,
    };
    std::process::exit(code);
}

pub(crate) fn try_open_clipboard(owner: Option<isize>) -> bool {
    let hwnd = owner
        .map(|handle| handle as HWND)
        .unwrap_or(std::ptr::null_mut());
    unsafe { OpenClipboard(hwnd) != 0 }
}

pub(crate) fn close_clipboard() {
    unsafe {
        let _ = CloseClipboard();
    }
}

/// A message-only `STATIC` window, parented to `HWND_MESSAGE` - just enough
/// of a window handle to own the clipboard from, with nothing to show.
fn message_only_window() -> HWND {
    let class = fixture_window::wide("STATIC");
    let title = fixture_window::wide("");
    unsafe {
        CreateWindowExW(
            0,
            class.as_ptr(),
            title.as_ptr(),
            0,
            0,
            0,
            0,
            0,
            HWND_MESSAGE,
            std::ptr::null_mut(),
            GetModuleHandleW(std::ptr::null()),
            std::ptr::null(),
        )
    }
}

fn hold_clipboard_until_release() -> Result<(), String> {
    let window = message_only_window();
    if window.is_null() {
        return Err(String::from("CreateWindowExW failed for clipboard holder"));
    }
    if let Err(error) = open_clipboard_when_free(window) {
        unsafe { DestroyWindow(window) };
        return Err(error);
    }
    println!("{READY_PREFIX}");
    let _ = std::io::stdout().flush();
    let mut line = String::new();
    let _ = std::io::stdin().read_line(&mut line);
    unsafe {
        let _ = CloseClipboard();
        DestroyWindow(window);
    }
    Ok(())
}

/// Opens the clipboard once whichever process held it last lets go.
///
/// Clipboard listeners on the runner (history, remote-session sync) open the
/// clipboard right after every write for a few milliseconds, so a single
/// `OpenClipboard` call can lose that race against the write the parent test
/// just made. The wait is bounded and ends on the first successful open.
fn open_clipboard_when_free(window: HWND) -> Result<(), String> {
    let give_up = std::time::Instant::now() + OPEN_CLIPBOARD_PATIENCE;
    loop {
        if unsafe { OpenClipboard(window) } != 0 {
            return Ok(());
        }
        let error = unsafe { GetLastError() };
        if std::time::Instant::now() >= give_up {
            return Err(format!("OpenClipboard failed in holder: {error}"));
        }
        std::thread::sleep(OPEN_CLIPBOARD_POLL);
    }
}

fn delayed_owner_thread(
    class_name: &str,
    ready: Sender<Result<isize, String>>,
    stop: Arc<AtomicBool>,
) {
    if let Err(error) = fixture_window::register_class(class_name) {
        let _ = ready.send(Err(error));
        return;
    }
    let name = fixture_window::wide(class_name);
    let title = fixture_window::wide("agent-desktop delayed clipboard owner");
    let stage = fixture_window::offscreen_stage();
    let (left, top) = stage.origin();
    let window = unsafe {
        CreateWindowExW(
            0,
            name.as_ptr(),
            title.as_ptr(),
            WS_OVERLAPPEDWINDOW,
            left,
            top,
            160,
            120,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            GetModuleHandleW(std::ptr::null()),
            std::ptr::null(),
        )
    };
    if window.is_null() {
        let _ = ready.send(Err(
            "CreateWindowExW produced no delayed-owner window".into()
        ));
        return;
    }
    unsafe { ShowWindow(window, SW_SHOWNOACTIVATE) };
    if let Err(error) = advertise_delayed_format(window) {
        unsafe { DestroyWindow(window) };
        let _ = ready.send(Err(error));
        return;
    }
    let _ = ready.send(Ok(window as isize));
    while !stop.load(Ordering::SeqCst) {
        std::thread::sleep(STALL_POLL);
    }
    unsafe { DestroyWindow(window) };
}

fn advertise_delayed_format(window: HWND) -> Result<(), String> {
    if unsafe { OpenClipboard(window) } == 0 {
        return Err(format!(
            "OpenClipboard failed for delayed owner: {}",
            unsafe { GetLastError() }
        ));
    }
    if unsafe { EmptyClipboard() } == 0 {
        unsafe {
            let _ = CloseClipboard();
        }
        return Err(format!(
            "EmptyClipboard failed for delayed owner: {}",
            unsafe { GetLastError() }
        ));
    }
    unsafe { SetLastError(0) };
    let set = unsafe { SetClipboardData(CF_UNICODETEXT, std::ptr::null_mut()) };
    let error = unsafe { GetLastError() };
    if set.is_null() && error != 0 {
        unsafe {
            let _ = CloseClipboard();
        }
        return Err(format!("SetClipboardData(NULL) failed: {error}"));
    }
    if unsafe { CloseClipboard() } == 0 {
        return Err(format!(
            "CloseClipboard failed for delayed owner: {}",
            unsafe { GetLastError() }
        ));
    }
    Ok(())
}

fn clear_clipboard_best_effort() {
    let window = message_only_window();
    if window.is_null() {
        return;
    }
    if unsafe { OpenClipboard(window) } != 0 {
        unsafe {
            let _ = EmptyClipboard();
            let _ = CloseClipboard();
        }
    }
    unsafe {
        DestroyWindow(window);
    }
}

#[cfg(test)]
#[path = "fixture_clipboard_tests.rs"]
mod tests;
