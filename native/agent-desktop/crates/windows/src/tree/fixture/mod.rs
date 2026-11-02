use std::process::{Child, Command};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Sender, channel};
use std::thread::{JoinHandle, spawn};
use std::time::Duration;

pub(crate) use super::fixture::fixture_window::{CONTENT_MARKER, SECURE_MARKER};

pub(crate) use super::fixture::fixture_pattern::LocalPatternFixture;

const HOST_ENVIRONMENT_FLAG: &str = "AGENT_DESKTOP_FIXTURE_HOST";
pub(crate) const SWALLOW_WM_CLOSE_FLAG: &str = "AGENT_DESKTOP_FIXTURE_SWALLOW_WM_CLOSE";
const HOST_TEST_NAME: &str = "tree::fixture::tests::fixture_host_process_entry";
const HANDLE_PREFIX: &str = "AGENT_DESKTOP_FIXTURE_HWND=";
const READY_TIMEOUT: Duration = Duration::from_secs(30);
const WALKABLE_TIMEOUT: Duration = Duration::from_secs(20);
const WALKABLE_POLL: Duration = Duration::from_millis(100);
const STALL_POLL: Duration = Duration::from_millis(25);

/// Joins this thread to the multithreaded apartment for a test.
///
/// `ensure_owned_process_mta_and_dpi` is wrong here and the reason is not
/// cosmetic: `CoInitializeEx` is thread-local while that bootstrap's guard is
/// process-wide, so in a multi-threaded test binary only the first thread to
/// call it ever joins the apartment and every other thread sees
/// `CO_E_NOTINITIALIZED` from `CoCreateInstance`. Its own contract says as
/// much - it is sound for the CLI because the CLI calls it once from `main`
/// before any COM work. Libtest's worker threads are threads this product
/// does not own, which is exactly the case `CoIncrementMTAUsage` exists for.
/// The single entry every Windows-gated test uses before touching UI
/// Automation. Four modules previously each defined their own one-line
/// `bootstrap()` around this call.
pub(crate) fn bootstrap() {
    ensure_test_apartment();
}

pub(crate) fn ensure_test_apartment() {
    crate::system::runtime::com_runtime::ensure_hosted_library_mta_and_dpi()
        .expect("the process-wide MTA registration succeeds");
}

/// Reports whether this process was re-executed to host a fixture window.
pub(crate) fn is_host_process() -> bool {
    std::env::var(HOST_ENVIRONMENT_FLAG).is_ok()
}

/// Creates the window and pumps until the parent ends this process.
///
/// Only the re-executed child calls it. The watchdog bounds the process even
/// if the parent is killed without running `HostedFixture`'s `Drop`, so a
/// crashed test run cannot leave a window host behind on a shared runner.
pub(crate) fn run_as_host() {
    super::fixture::fixture_menu::run_with_watchdog(host_fixture_window);
}

fn host_fixture_window() {
    let (sender, receiver) = channel::<Result<fixture_window::PumpHandle, String>>();
    spawn(move || {
        if let Ok(Ok(running)) = receiver.recv_timeout(READY_TIMEOUT) {
            println!("{HANDLE_PREFIX}{}", running.window);
        }
    });
    fixture_window::host_window(&fixture_window::unique_class_name(), sender);
}

/// A fixture window hosted in a second process.
///
/// This is the default for walk and cache tests. A window the test process
/// creates itself is served by in-process client-side providers, so the
/// failure taxonomy the walker exists to classify - RPC failure against
/// exhaustion, a target that stops pumping - is structurally unreachable
/// from it, and a cache policy validated there is validated against exactly
/// the provider class the policy says to skip.
pub(crate) struct HostedFixture {
    child: Option<Child>,
    handle: isize,
}

impl HostedFixture {
    pub(crate) fn spawn() -> Result<Self, String> {
        Self::spawn_with_close_mode(false)
    }

    /// Host whose wndproc returns 0 on `WM_CLOSE` without destroying the
    /// window — a non-cooperating child for force-close verification.
    pub(crate) fn spawn_swallowing_wm_close() -> Result<Self, String> {
        Self::spawn_with_close_mode(true)
    }

    fn spawn_with_close_mode(swallow_wm_close: bool) -> Result<Self, String> {
        let executable = std::env::current_exe().map_err(|error| error.to_string())?;
        let mut command = Command::new(executable);
        command
            .args(["--exact", HOST_TEST_NAME, "--ignored", "--nocapture"])
            .env(HOST_ENVIRONMENT_FLAG, "1");
        if swallow_wm_close {
            command.env(SWALLOW_WM_CLOSE_FLAG, "1");
        }
        let (mut child, handle, _reader) = fixture_spawn::spawn_host(
            command,
            fixture_spawn::first_line(|line| {
                line.strip_prefix(HANDLE_PREFIX)
                    .map(|handle| handle.trim().parse::<isize>().unwrap_or(0))
            }),
            |handle| *handle != 0,
            "the fixture host exposed no stdout",
            "the fixture host never reported a window handle",
        )?;
        if let Err(error) = await_walkable(handle) {
            fixture_spawn::kill_and_wait(&mut child);
            return Err(error);
        }
        Ok(Self {
            child: Some(child),
            handle,
        })
    }

    pub(crate) fn handle(&self) -> isize {
        self.handle
    }

    pub(crate) fn process_id(&self) -> u32 {
        self.child.as_ref().map(Child::id).unwrap_or_default()
    }

    /// Ends the host process and waits for it, so a test can observe what the
    /// walk does against a provider that has genuinely gone away.
    pub(crate) fn terminate(&mut self) {
        if let Some(mut child) = self.child.take() {
            fixture_spawn::kill_and_wait(&mut child);
        }
    }
}

impl Drop for HostedFixture {
    fn drop(&mut self) {
        self.terminate();
    }
}

/// A fixture window hosted on a worker thread of the test process.
///
/// Retained only for teardown and concurrency tests. Never use it to validate
/// the walk's failure classification or the cache policy.
pub(crate) struct LocalFixture {
    handle: isize,
    pump_thread_id: u32,
    class_name: String,
    pump: Option<JoinHandle<()>>,
    origin: (i32, i32),
    _stage: Option<std::sync::MutexGuard<'static, ()>>,
}

impl LocalFixture {
    pub(crate) fn create() -> Result<Self, String> {
        let stage = fixture_window::offscreen_stage();
        let (left, top) = stage.origin();
        let guard = match stage {
            crate::tree::fixture::offscreen_origin::Stage::Parked { .. } => None,
            crate::tree::fixture::offscreen_origin::Stage::OnScreen { guard, .. } => Some(guard),
        };
        let mut fixture = Self::create_at(left, top)?;
        fixture._stage = guard;
        Ok(fixture)
    }

    /// Parks the fixture at a caller-chosen origin so live hit-test legs can
    /// place the window inside the virtual screen rect.
    pub(crate) fn create_at(left: i32, top: i32) -> Result<Self, String> {
        let class_name = fixture_window::unique_class_name();
        let (sender, receiver) = channel();
        let pump = spawn({
            let class_name = class_name.clone();
            move || fixture_window::host_window_at(&class_name, sender, left, top)
        });
        let running = match receiver.recv_timeout(READY_TIMEOUT) {
            Ok(Ok(running)) => running,
            Ok(Err(error)) => return Err(error),
            Err(_) => return Err(String::from("the fixture window never became ready")),
        };
        if let Err(error) = await_walkable(running.window) {
            fixture_window::close_window(running.window);
            fixture_window::quit_pump(running.thread_id);
            let _ = pump.join();
            fixture_window::destroy_window(running.window);
            fixture_window::unregister_class(&class_name);
            return Err(error);
        }
        Ok(Self {
            handle: running.window,
            pump_thread_id: running.thread_id,
            class_name,
            pump: Some(pump),
            origin: (left, top),
            _stage: None,
        })
    }

    pub(crate) fn handle(&self) -> isize {
        self.handle
    }

    /// The origin this fixture actually parked at, so a caller asserting a
    /// point relative to the window never has to re-derive it.
    pub(crate) fn origin(&self) -> (i32, i32) {
        self.origin
    }

    pub(crate) fn geometry(&self) -> fixture_window::WindowGeometry {
        fixture_window::geometry(self.handle)
    }

    /// Identifies the thread that owns the window and runs its pump, so a
    /// test can assert that no UI Automation call is issued from it.
    pub(crate) fn pump_thread_id(&self) -> Option<std::thread::ThreadId> {
        self.pump.as_ref().map(|pump| pump.thread().id())
    }

    pub(crate) fn minimize(&self) {
        fixture_window::minimize_window(self.handle);
    }
}

impl Drop for LocalFixture {
    fn drop(&mut self) {
        fixture_window::close_window(self.handle);
        fixture_window::quit_pump(self.pump_thread_id);
        if let Some(pump) = self.pump.take() {
            let _ = pump.join();
        }
        fixture_window::destroy_window(self.handle);
        fixture_window::unregister_class(&self.class_name);
    }
}

/// A window whose thread owns it but never dispatches its messages.
///
/// The host thread cannot be joined the ordinary way - joining means waiting
/// for it to finish, and finishing means it stopped owning the window this
/// fixture exists to keep stalled. Instead it is told to stop and polls for
/// that signal, so teardown ends it in milliseconds rather than leaving a
/// parked thread per test.
pub(crate) struct StalledFixture {
    handle: isize,
    class_name: String,
    stop: Arc<AtomicBool>,
    host: Option<JoinHandle<()>>,
}

impl StalledFixture {
    pub(crate) fn create() -> Result<Self, String> {
        let class_name = fixture_window::unique_class_name();
        let stop = Arc::new(AtomicBool::new(false));
        let (sender, receiver) = channel();
        let host = spawn({
            let class_name = class_name.clone();
            let stop = stop.clone();
            move || stalled_window(&class_name, sender, stop)
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
                Err(String::from("the stalled window never became ready"))
            }
        }
    }

    pub(crate) fn handle(&self) -> isize {
        self.handle
    }
}

impl Drop for StalledFixture {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(host) = self.host.take() {
            let _ = host.join();
        }
        fixture_window::unregister_class(&self.class_name);
    }
}

fn stalled_window(class_name: &str, ready: Sender<Result<isize, String>>, stop: Arc<AtomicBool>) {
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DestroyWindow, SW_SHOWNOACTIVATE, ShowWindow, WS_OVERLAPPEDWINDOW,
    };

    if let Err(error) = fixture_window::register_class(class_name) {
        let _ = ready.send(Err(error));
        return;
    }
    let name = fixture_window::wide(class_name);
    let title = fixture_window::wide("agent-desktop stalled fixture");
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
            420,
            320,
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
    unsafe { ShowWindow(window, SW_SHOWNOACTIVATE) };
    let _ = ready.send(Ok(window as isize));
    while !stop.load(Ordering::SeqCst) {
        std::thread::sleep(STALL_POLL);
    }
    unsafe { DestroyWindow(window) };
}

/// Blocks until the window actually resolves to a UI Automation root.
///
/// A pumping window is necessary but not sufficient. `ElementFromHandle`
/// sends `WM_GETOBJECT`, and that `SendMessage` carries its own timeout, so on
/// a loaded runner starting several fixture hosts at once the first call can
/// return `E_FAIL` against a window that is perfectly healthy a moment later.
/// The fixture's contract is a walkable window, so it does not hand one out
/// until it is one - which keeps the retry in the harness rather than
/// smuggling it into the product's resolver.
fn await_walkable(handle: isize) -> Result<(), String> {
    let deadline = std::time::Instant::now() + WALKABLE_TIMEOUT;
    let mut last = String::from("the fixture window never resolved");
    while std::time::Instant::now() < deadline {
        match crate::tree::automation::root_from_hwnd(
            handle,
            agent_desktop_core::Deadline::standard().map_err(|error| error.message.clone())?,
        ) {
            Ok(_) => return Ok(()),
            Err(error) => last = error.message.clone(),
        }
        std::thread::sleep(WALKABLE_POLL);
    }
    Err(last)
}

#[cfg(all(test, target_os = "windows"))]
pub(crate) mod fixture_clipboard;
#[cfg(all(test, target_os = "windows"))]
pub(crate) mod fixture_menu;
#[cfg(all(test, target_os = "windows"))]
pub(crate) mod fixture_modal;
#[cfg(all(test, target_os = "windows"))]
pub(crate) mod fixture_overlay;
#[cfg(all(test, target_os = "windows"))]
pub(crate) mod fixture_pattern;
#[cfg(all(test, target_os = "windows"))]
pub(crate) mod fixture_spawn;
#[cfg(all(test, target_os = "windows"))]
pub(crate) mod fixture_window;
#[cfg(all(test, target_os = "windows"))]
pub(crate) mod offscreen_origin;
#[cfg(test)]
#[path = "fixture_tests.rs"]
mod tests;

pub(crate) mod fixture_hung_after_probe;
