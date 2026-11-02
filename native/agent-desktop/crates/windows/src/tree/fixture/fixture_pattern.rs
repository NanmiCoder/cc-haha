use std::process::{Child, Command};
use std::sync::MutexGuard;
use std::sync::mpsc::channel;
use std::thread::{JoinHandle, spawn};
use std::time::Duration;

use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::UI::WindowsAndMessaging::{GetClassInfoExW, WNDCLASSEXW};

use super::fixture_spawn;
use super::fixture_window;

#[path = "fixture_pattern_gdi.rs"]
mod gdi;

const HOST_ENVIRONMENT_FLAG: &str = "AGENT_DESKTOP_PATTERN_FIXTURE_HOST";
const HOST_TEST_NAME: &str =
    "tree::fixture::fixture_pattern::tests::pattern_fixture_host_process_entry";
const HANDLE_PREFIX: &str = "AGENT_DESKTOP_PATTERN_HWND=";
const READY_TIMEOUT: Duration = Duration::from_secs(30);

pub(crate) const PATTERN_WIDTH: i32 = 240;
pub(crate) const PATTERN_HEIGHT: i32 = 160;

/// Fixed RGB colours for the four client-area quadrants.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct PatternColors {
    pub(crate) top_left: [u8; 3],
    pub(crate) top_right: [u8; 3],
    pub(crate) bottom_left: [u8; 3],
    pub(crate) bottom_right: [u8; 3],
}

impl PatternColors {
    pub(crate) const fn standard() -> Self {
        Self {
            top_left: [0xE0, 0x20, 0x20],
            top_right: [0x20, 0xC0, 0x20],
            bottom_left: [0x20, 0x40, 0xE0],
            bottom_right: [0xE0, 0xC0, 0x20],
        }
    }
}

/// Expected pattern geometry and colours used by capture assertions.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct PatternExpectation {
    pub(crate) width: i32,
    pub(crate) height: i32,
    pub(crate) colors: PatternColors,
}

impl PatternExpectation {
    pub(crate) const fn standard() -> Self {
        Self {
            width: PATTERN_WIDTH,
            height: PATTERN_HEIGHT,
            colors: PatternColors::standard(),
        }
    }

    pub(crate) fn sample_points(self) -> [SamplePoint; 4] {
        let qx = self.width / 4;
        let qy = self.height / 4;
        [
            SamplePoint {
                x: qx,
                y: qy,
                rgb: self.colors.top_left,
            },
            SamplePoint {
                x: self.width - qx,
                y: qy,
                rgb: self.colors.top_right,
            },
            SamplePoint {
                x: qx,
                y: self.height - qy,
                rgb: self.colors.bottom_left,
            },
            SamplePoint {
                x: self.width - qx,
                y: self.height - qy,
                rgb: self.colors.bottom_right,
            },
        ]
    }

    pub(crate) fn matches_samples(self, samples: &[[u8; 3]; 4]) -> bool {
        self.sample_points()
            .iter()
            .zip(samples.iter())
            .all(|(expected, observed)| expected.rgb == *observed)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct SamplePoint {
    pub(crate) x: i32,
    pub(crate) y: i32,
    pub(crate) rgb: [u8; 3],
}

/// In-process pattern window for pixel-read capture tests.
///
/// Default creation stages on-screen under `on_screen_stage` so a plain GDI
/// blit of the client DC can read the painted quadrants; DWM leaves an
/// off-screen popup's `GetDC` bits unreadably black. Callers that only need
/// `WM_PRINTCLIENT` may still use `create_at` with an off-screen origin.
pub(crate) struct LocalPatternFixture {
    handle: isize,
    pump_thread_id: u32,
    class_name: String,
    expectation: PatternExpectation,
    pump: Option<JoinHandle<()>>,
    _stage: Option<MutexGuard<'static, ()>>,
}

impl LocalPatternFixture {
    pub(crate) fn create() -> Result<Self, String> {
        let stage = fixture_window::on_screen_stage();
        let (left, top) = fixture_window::on_screen_origin();
        let mut fixture = Self::create_at(left, top)?;
        fixture._stage = Some(stage);
        Ok(fixture)
    }

    pub(crate) fn create_at(left: i32, top: i32) -> Result<Self, String> {
        let class_name = fixture_window::unique_class_name();
        let (sender, receiver) = channel();
        let pump = spawn({
            let class_name = class_name.clone();
            move || gdi::host_pattern_window(&class_name, sender, left, top)
        });
        let running = match receiver.recv_timeout(READY_TIMEOUT) {
            Ok(Ok(running)) => running,
            Ok(Err(error)) => return Err(error),
            Err(_) => return Err(String::from("the pattern fixture never became ready")),
        };
        gdi::force_paint(running.window)?;
        Ok(Self {
            handle: running.window,
            pump_thread_id: running.thread_id,
            class_name,
            expectation: PatternExpectation::standard(),
            pump: Some(pump),
            _stage: None,
        })
    }

    pub(crate) fn handle(&self) -> isize {
        self.handle
    }

    pub(crate) fn class_name(&self) -> &str {
        &self.class_name
    }

    pub(crate) fn expectation(&self) -> PatternExpectation {
        self.expectation
    }

    pub(crate) fn blit_client_samples(&self) -> Result<[[u8; 3]; 4], String> {
        gdi::blit_client_samples(self.handle, self.expectation)
    }

    pub(crate) fn printclient_samples(&self) -> Result<[[u8; 3]; 4], String> {
        gdi::printclient_samples(self.handle, self.expectation)
    }
}

impl Drop for LocalPatternFixture {
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

/// Pattern window hosted in a second process for process-scoped capture legs.
pub(crate) struct HostedPatternFixture {
    child: Option<Child>,
    handle: isize,
}

impl HostedPatternFixture {
    pub(crate) fn spawn() -> Result<Self, String> {
        let executable = std::env::current_exe().map_err(|error| error.to_string())?;
        let mut command = Command::new(executable);
        command
            .args(["--exact", HOST_TEST_NAME, "--ignored", "--nocapture"])
            .env(HOST_ENVIRONMENT_FLAG, "1");
        let (child, handle, _reader) = fixture_spawn::spawn_host(
            command,
            fixture_spawn::first_line(|line| {
                line.strip_prefix(HANDLE_PREFIX)
                    .map(|handle| handle.trim().parse::<isize>().unwrap_or(0))
            }),
            |handle| *handle != 0,
            "the pattern host exposed no stdout",
            "the pattern host never reported a window handle",
        )?;
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

    pub(crate) fn terminate(&mut self) {
        if let Some(mut child) = self.child.take() {
            fixture_spawn::kill_and_wait(&mut child);
        }
    }
}

impl Drop for HostedPatternFixture {
    fn drop(&mut self) {
        self.terminate();
    }
}

pub(crate) fn is_pattern_host_process() -> bool {
    std::env::var(HOST_ENVIRONMENT_FLAG).is_ok()
}

pub(crate) fn run_as_pattern_host() {
    super::fixture_menu::run_with_watchdog(host_pattern_fixture_window);
}

fn host_pattern_fixture_window() {
    let (sender, receiver) = channel::<Result<fixture_window::PumpHandle, String>>();
    spawn(move || {
        if let Ok(Ok(running)) = receiver.recv_timeout(READY_TIMEOUT) {
            println!("{HANDLE_PREFIX}{}", running.window);
        }
    });
    let stage = crate::tree::fixture::offscreen_origin::stage(None, PATTERN_WIDTH, PATTERN_HEIGHT);
    let (left, top) = stage.origin();
    gdi::host_pattern_window(&fixture_window::unique_class_name(), sender, left, top);
}

pub(crate) fn window_still_exists(handle: isize) -> bool {
    crate::tree::automation::window_exists(handle)
}

pub(crate) fn class_still_registered(class_name: &str) -> bool {
    let name = fixture_window::wide(class_name);
    let mut info = WNDCLASSEXW {
        cbSize: size_of::<WNDCLASSEXW>() as u32,
        ..Default::default()
    };
    unsafe { GetClassInfoExW(GetModuleHandleW(std::ptr::null()), name.as_ptr(), &mut info) != 0 }
}

#[cfg(test)]
#[path = "fixture_pattern_tests.rs"]
mod tests;
