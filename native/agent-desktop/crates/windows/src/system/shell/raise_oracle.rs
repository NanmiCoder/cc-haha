//! The independent raise-response oracle behind the shell-surface skip
//! convention.
//!
//! `shell_declined_the_surface` classifies the product's own TIMEOUT
//! envelopes, so on its own it cannot tell a declining desktop from a product
//! whose resolver or raise machinery regressed - the same envelope comes back
//! for both, and every immersive round-trip test would skip green. This
//! module observes whether the shell answered a raise at all, reading raw
//! Win32 and UI Automation state directly: `GetForegroundWindow`,
//! `automation_client` + `get_root_element` + `find_all(Children)` over the
//! desktop root, and a raw `EnumWindows` pass. The product's resolver and
//! raise path are never consulted - that is the independence the skip
//! decision was missing.
//!
//! Residual limits, stated where they belong:
//!
//! - A raise whose chord was dropped before the OS is indistinguishable from
//!   a shell-less desktop by observation alone: nothing on the desktop
//!   changes, the oracle answers "did not respond", and the leg skips - the
//!   regression that broke the raise itself hides. The dev box, where the
//!   shell answers every real accelerator, is what keeps that assertion
//!   honest.
//! - A desktop change the raise did not cause - a sibling test's window
//!   appearing inside the poll window - reads as a response. Observation
//!   alone cannot attribute a change, so the oracle narrows what it watches
//!   to surface-shaped responses: a shell-host-owned `Windows.UI.Core.CoreWindow`
//!   child at the root, or the foreground moving to one (A26-1/A26-9). A
//!   fixture spawning, a toast preview, or a non-CoreWindow flyout moves
//!   none of them, so parallel-suite noise and shell chrome a raise did not
//!   mean to present cannot read as the shell answering a raise.

#![cfg(all(test, target_os = "windows"))]

use std::time::{Duration, Instant};

/// The shell host images whose windows a raise can present through, and the
/// class those windows present as, measured by the probe corpus (A26-1:
/// `shellexperiencehost` hosts the Action Center's CoreWindow; A26-9: the
/// Start accelerator's overlay is search-hosted). Environment facts about
/// which process presents shell chrome and in what window class - not the
/// product's matching logic, which this oracle must never consult.
const SHELL_HOST_IMAGES: &[&str] = &[
    "shellexperiencehost",
    "searchhost",
    "searchui",
    "searchapp",
    "startmenuexperiencehost",
];
const SHELL_CORE_WINDOW_CLASS: &str = "Windows.UI.Core.CoreWindow";

/// How long a response verdict polls before answering "did not respond".
const RESPONSE_WINDOW: Duration = Duration::from_secs(3);
const RESPONSE_POLL: Duration = Duration::from_millis(250);

/// The desktop state a raise-response verdict is measured against, captured
/// before the raise attempt: the foreground window (with whether the shell
/// presents it as a CoreWindow) and the shell-host CoreWindow children at
/// the root.
pub(crate) struct RaiseWitness {
    foreground: isize,
    foreground_is_shell_core_window: bool,
    shell_core_window_root_children: Vec<isize>,
}

impl RaiseWitness {
    fn moved_since(&self, witness: &RaiseWitness) -> bool {
        (self.foreground != witness.foreground && self.foreground_is_shell_core_window)
            || self.shell_core_window_root_children != witness.shell_core_window_root_children
    }
}

/// Captures the pre-raise state [`shell_responded_to_raise`] compares
/// against: the foreground window and the shell-host CoreWindow children at
/// the root. One `find_all` over the root plus per-child class and owner
/// reads - cheap enough to sit in front of every raise attempt a live test
/// makes.
///
/// `None` when the desktop's state cannot be read at all. A witness the
/// harness cannot take is a desktop the oracle cannot speak about, so the
/// caller's skip convention stands unchanged rather than gaining a verdict
/// invented from missing evidence.
pub(crate) fn witness_desktop() -> Option<RaiseWitness> {
    read_desktop()
}

/// Whether the desktop moved away from the witness since the raise attempt:
/// the foreground moved to a shell-host CoreWindow, or the set of
/// shell-host CoreWindow children at the root changed (the immersive
/// surfaces present exactly that way, A26-1). Polled across
/// [`RESPONSE_WINDOW`] so a shell that answers a beat late is still seen; a
/// desktop that never responds exhausts the window and answers `false`.
pub(crate) fn shell_responded_to_raise(witness: &RaiseWitness) -> bool {
    let deadline = Instant::now() + RESPONSE_WINDOW;
    loop {
        if let Some(current) = read_desktop() {
            if current.moved_since(witness) {
                return true;
            }
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(RESPONSE_POLL);
    }
}

/// The closure shape `or_skip_shell` consumes. A witness that could not be
/// captured keeps the skip convention: no evidence, no verdict.
pub(crate) fn responded_since(witness: &Option<RaiseWitness>) -> bool {
    witness.as_ref().is_some_and(shell_responded_to_raise)
}

fn read_desktop() -> Option<RaiseWitness> {
    Some(RaiseWitness {
        foreground: foreground_hwnd(),
        foreground_is_shell_core_window: foreground_hwnd_is_shell_core_window(),
        shell_core_window_root_children: uia_shell_core_window_root_children()?,
    })
}

fn foreground_hwnd() -> isize {
    use windows_sys::Win32::UI::WindowsAndMessaging::GetForegroundWindow;

    (unsafe { GetForegroundWindow() }) as isize
}

/// Whether the foreground window is a shell-host-owned CoreWindow - the
/// surface shape a raise presents, not merely shell chrome happening to be
/// foreground.
fn foreground_hwnd_is_shell_core_window() -> bool {
    let handle = foreground_hwnd();
    if handle == 0 {
        return false;
    }
    let owned_by_shell_host = crate::system::window::window_identity::live_window_owner(
        handle as crate::system::window::window_enum::WindowHandle,
    )
    .and_then(crate::system::process_identity::process_image_name)
    .is_some_and(|image| {
        let stem = image.strip_suffix(".exe").unwrap_or(&image).to_lowercase();
        SHELL_HOST_IMAGES.iter().any(|host| stem == *host)
    });
    if !owned_by_shell_host {
        return false;
    }
    crate::system::window::window_ops::window_class_name(
        handle as crate::system::window::window_enum::WindowHandle,
    )
    .is_some_and(|class| class.eq_ignore_ascii_case(SHELL_CORE_WINDOW_CLASS))
}

/// The shell-host CoreWindow children at the desktop root, read straight off
/// UI Automation - the enumeration the immersive surfaces present in
/// (A26-1), narrowed to the owning process and the window class, with no
/// landmark or cloak matching. Sibling tests' fixtures and non-CoreWindow
/// shell flyouts never enter this set, so parallel-suite noise and shell
/// chrome a raise did not mean to present cannot read as a response.
fn uia_shell_core_window_root_children() -> Option<Vec<isize>> {
    use uiautomation::types::TreeScope;

    let client = crate::tree::automation::automation_client().ok()?;
    let root = client.get_root_element().ok()?;
    let condition = client.create_true_condition().ok()?;
    let children = root.find_all(TreeScope::Children, &condition).ok()?;
    let mut handles: Vec<isize> = children
        .iter()
        .filter_map(|child| {
            let classname = child.get_classname().ok()?;
            if !classname.eq_ignore_ascii_case(SHELL_CORE_WINDOW_CLASS) {
                return None;
            }
            let handle: isize = child.get_native_window_handle().ok()?.into();
            if handle == 0 {
                return None;
            }
            let pid = child.get_process_id().ok()?;
            let image = crate::system::process_identity::process_image_name(pid.into())?;
            let stem = image.strip_suffix(".exe").unwrap_or(&image).to_lowercase();
            SHELL_HOST_IMAGES
                .iter()
                .any(|host| stem == *host)
                .then_some(handle)
        })
        .collect();
    handles.sort_unstable();
    Some(handles)
}

#[path = "raise_oracle_tests.rs"]
mod tests;
