//! The desktop harness these teardown tests share: a scratch state root, a
//! lock that keeps them off each other's screen, and the oracles they read
//! the desktop with.
//!
//! Split from the tests themselves so each file stays under the size cap and
//! the assertions read without the plumbing in front of them.

use super::screen_sample;
use std::path::PathBuf;
use std::process::Command;
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};

#[path = "unique_scratch_dir.rs"]
mod unique_scratch_dir;
use unique_scratch_dir::unique_scratch_dir;

/// The overlay needs a desktop to draw on, and staging one is the same opt-in
/// the other on-screen suites use rather than a second variable to discover.
const LIVE_STAGE_VARIABLE: &str = "AGENT_DESKTOP_LIVE_WPF";

/// A colour nothing else on the desktop paints, so counting exact matches is
/// evidence instead of noise.
const ORACLE: (u8, u8, u8) = (0xFF, 0x00, 0xFF);
const ORACLE_HEX: &str = "#FF00FF";

const SETTLE: Duration = Duration::from_secs(6);

/// These tests share one desktop, one oracle colour and one process table,
/// so they cannot run beside each other: one overlay's pixels satisfy
/// another's "still painted" wait and defeat its "torn down" wait. libtest
/// runs a target's tests concurrently by default, so the serialization has to
/// be here rather than assumed from a runner flag.
fn desktop() -> MutexGuard<'static, ()> {
    static DESKTOP: OnceLock<Mutex<()>> = OnceLock::new();
    match DESKTOP.get_or_init(|| Mutex::new(())).lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}

pub(crate) struct Scratch {
    pub(crate) root: PathBuf,
    session: Mutex<Option<String>>,
    _desktop: MutexGuard<'static, ()>,
}

impl Scratch {
    pub(crate) fn create(label: &str) -> Self {
        Self {
            root: unique_scratch_dir("overlay", label),
            session: Mutex::new(None),
            _desktop: desktop(),
        }
    }

    /// Remembered so teardown reaps this test's own renderer and nothing
    /// else. An unscoped reap matches every overlay on the machine, including
    /// one a developer is looking at.
    fn owns(&self, session: &str) {
        if let Ok(mut held) = self.session.lock() {
            *held = Some(session.to_owned());
        }
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let session = self
            .session
            .lock()
            .ok()
            .and_then(|held| held.clone())
            .unwrap_or_default();
        if session.is_empty() {
            let _ = std::fs::remove_dir_all(&self.root);
            return;
        }
        for id in overlay_children(&session) {
            let _ = Command::new("taskkill")
                .args(["/PID", &id.to_string(), "/F"])
                .output();
        }
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

/// These need a composited desktop that can be read back pixel by pixel, and
/// a hosted CI runner does not have one: it has enough window station for UI
/// Automation, so a fixture window stages there quite happily while a layered
/// overlay reads as zero pixels. Asserting there fails for a reason that says
/// nothing about the renderer.
///
/// So they run where every other live Windows check on this project runs —
/// `scripts/run-windows-e2e-ci.ps1`, under the exclusive desktop lease, which
/// sets this variable and fails the run if they fail. An earlier version of
/// this message claimed a CI lane owned executing them. Nothing did.
pub(crate) fn skip_unless_live_staging(reason: &str) -> bool {
    if std::env::var_os(LIVE_STAGE_VARIABLE).is_none() {
        eprintln!(
            "skip {reason}: {LIVE_STAGE_VARIABLE} is unset, so no readable desktop was \
             authorised; run scripts/run-windows-e2e-ci.ps1, which executes these under the \
             desktop lease"
        );
        return true;
    }
    false
}

pub(crate) fn run(scratch: &Scratch, args: &[&str]) -> serde_json::Value {
    let output = Command::new(env!("CARGO_BIN_EXE_agent-desktop"))
        .args(args)
        .env("AGENT_DESKTOP_HOME", &scratch.root)
        .output()
        .expect("the binary starts");
    serde_json::from_slice(&output.stdout).unwrap_or_else(|error| {
        panic!(
            "`{}` did not answer one JSON envelope ({error}): {}",
            args.join(" "),
            String::from_utf8_lossy(&output.stdout)
        )
    })
}

pub(crate) fn start_session(scratch: &Scratch) -> String {
    let envelope = run(scratch, &["session", "start"]);
    assert_eq!(envelope["ok"], true, "the session must start: {envelope}");
    let id = envelope["data"]["session_id"]
        .as_str()
        .expect("a session id")
        .to_owned();
    scratch.owns(&id);
    id
}

pub(crate) fn enable(scratch: &Scratch, session: &str) -> serde_json::Value {
    run(
        scratch,
        &[
            "cursor-overlay",
            "enable",
            "--session",
            session,
            "--fill",
            ORACLE_HEX,
            "--rim",
            ORACLE_HEX,
        ],
    )
}

/// The renderer carries its session id in argv precisely so it can be found
/// from outside: it is a detached process with no console, no taskbar entry
/// and no window title to match on.
pub(crate) fn overlay_children(session: &str) -> Vec<u32> {
    let flag = agent_desktop_windows::CURSOR_OVERLAY_CHILD_FLAG;
    let script = format!(
        "Get-CimInstance Win32_Process -Filter \"Name='agent-desktop.exe'\" | \
         Where-Object {{ $_.CommandLine -like '*{flag}*{session}*' }} | \
         ForEach-Object {{ $_.ProcessId }}"
    );
    let output = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .output()
        .expect("powershell enumerates processes");
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| line.trim().parse::<u32>().ok())
        .collect()
}

/// Panics rather than answering zero when the screen cannot be read. A
/// capture fault reported as "no pixels" would satisfy every teardown wait on
/// its first poll, which is the failure this whole file exists to rule out.
pub(crate) fn oracle_pixels() -> usize {
    screen_sample::pixels_matching(ORACLE.0, ORACLE.1, ORACLE.2)
        .expect("the screen must be readable; a failed capture is not an empty screen")
}

/// Well inside one 1500ms idle tick, so the session watch cannot satisfy
/// these observations on the disable path's behalf.
///
/// The watch needs two consecutive readings and so reclaims in three to four
/// seconds; a budget of one whole tick would sit on its luckiest boundary
/// rather than clear of it. Measured at 26-62ms, so this is an order of
/// magnitude of headroom and still decisive.
pub(crate) const PROMPTLY: Duration = Duration::from_millis(600);

/// Waits for a condition instead of sleeping a fixed span and hoping. A
/// failure seen after a fixed sleep is a race, not a finding.
pub(crate) fn wait_until(what: &str, settled: impl FnMut() -> bool) {
    wait_within(SETTLE, what, settled);
}

pub(crate) fn wait_within(budget: Duration, what: &str, mut settled: impl FnMut() -> bool) {
    let deadline = Instant::now() + budget;
    while Instant::now() < deadline {
        if settled() {
            return;
        }
        std::thread::sleep(Duration::from_millis(120));
    }
    panic!("{what} did not happen within {budget:?}");
}
