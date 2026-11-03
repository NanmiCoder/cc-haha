//! Home-directory isolation and clipboard/PNG scaffolding shared by the
//! capture parity suites and the shell-surface command live suite.
//!
//! Every consumer needs `HOME`/`USERPROFILE` pointed at a scratch directory
//! this process owns for the length of one test, restored (and removed) on
//! the way out. Each call site keeps its own temp-directory prefix even
//! though the isolation is identical: naming apart is what keeps two suites
//! in the same test binary from colliding on one scratch home if their
//! process id and nanosecond timestamp ever coincided.

#![cfg(all(test, target_os = "windows"))]

use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use agent_desktop_core::{ClipboardContent, ClipboardFormat};

use crate::input::clipboard::{clear, get_clipboard_content, set_content};
use crate::system::capture::png_codec::encode_bgra_to_png;
use crate::system::fixture::test_time::deadline;
use crate::system::private_file::WindowsPrivateFile;
use crate::tree::fixture::bootstrap;
use crate::tree::fixture::fixture_clipboard::clipboard_test_lock;

static HOME_ENV_LOCK: Mutex<()> = Mutex::new(());
static LIVE_GRAPHICS_CAPTURE_LOCK: Mutex<()> = Mutex::new(());
const CAPTURE_IDLE_PATIENCE: std::time::Duration = std::time::Duration::from_secs(30);
const CAPTURE_IDLE_POLL: std::time::Duration = std::time::Duration::from_millis(20);

/// Serializes every test that opens a Windows.Graphics.Capture session.
///
/// Concurrent sessions each create their own D3D11 device and frame pool on
/// one shared compositor; on a CI runner they stalled together for minutes,
/// so one session at a time keeps each test's deadline about its own work.
///
/// It also waits for a capture an earlier test abandoned at its deadline to
/// release the process-wide single-flight slot, which otherwise refuses the
/// next capture with `AppUnresponsive`.
pub(crate) fn live_graphics_capture_lock() -> MutexGuard<'static, ()> {
    let guard = LIVE_GRAPHICS_CAPTURE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let give_up = std::time::Instant::now() + CAPTURE_IDLE_PATIENCE;
    while !super::native_call::capture_is_idle() && std::time::Instant::now() < give_up {
        std::thread::sleep(CAPTURE_IDLE_POLL);
    }
    guard
}

pub(crate) struct HomeIsolation {
    previous_home: Option<std::ffi::OsString>,
    previous_profile: Option<std::ffi::OsString>,
    root: PathBuf,
    _lock: MutexGuard<'static, ()>,
}

impl HomeIsolation {
    /// `prefix` names the caller in the scratch directory - see the module
    /// doc for why that naming survives centralizing the rest.
    pub(crate) fn enter(prefix: &str) -> Self {
        let lock = HOME_ENV_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let root = std::env::temp_dir().join(format!(
            "{prefix}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&root).expect("isolated home");
        let previous_home = std::env::var_os("HOME");
        let previous_profile = std::env::var_os("USERPROFILE");
        unsafe {
            std::env::set_var("HOME", &root);
            std::env::set_var("USERPROFILE", &root);
        }
        Self {
            previous_home,
            previous_profile,
            root,
            _lock: lock,
        }
    }

    pub(crate) fn path(&self) -> &Path {
        &self.root
    }
}

impl Drop for HomeIsolation {
    fn drop(&mut self) {
        match &self.previous_home {
            Some(value) => unsafe { std::env::set_var("HOME", value) },
            None => unsafe { std::env::remove_var("HOME") },
        }
        match &self.previous_profile {
            Some(value) => unsafe { std::env::set_var("USERPROFILE", value) },
            None => unsafe { std::env::remove_var("USERPROFILE") },
        }
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

pub(crate) fn install_windows_private_file() {
    let _ = agent_desktop_core::install_private_file_ops(Box::new(WindowsPrivateFile::new()));
}

pub(crate) fn sample_png() -> Vec<u8> {
    encode_bgra_to_png(
        &[
            10, 20, 30, 255, 40, 50, 60, 255, 70, 80, 90, 255, 100, 110, 120, 255,
        ],
        2,
        2,
        8,
        deadline(10_000),
    )
    .expect("png")
}

/// One pixel of a BGRA buffer, reordered to RGB, for asserting a capture's
/// content rather than only its dimensions.
pub(crate) fn sample_rgb(bgra: &[u8], width: u32, x: i32, y: i32) -> [u8; 3] {
    let offset = ((y as u32 * width + x as u32) * 4) as usize;
    [bgra[offset + 2], bgra[offset + 1], bgra[offset]]
}

pub(crate) fn with_restored_clipboard(body: impl FnOnce()) {
    let _lock = clipboard_test_lock();
    bootstrap();
    let saved_text = match get_clipboard_content(ClipboardFormat::Text, deadline(10_000)) {
        Ok(Some(ClipboardContent::Text(value))) => Some(value),
        _ => None,
    };
    let body_result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(body));
    let _ = clear(deadline(10_000));
    if let Some(text) = saved_text {
        let _ = set_content(&ClipboardContent::Text(text), deadline(10_000));
    }
    if let Err(panic) = body_result {
        std::panic::resume_unwind(panic);
    }
}
