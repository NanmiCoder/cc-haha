//! A hosted Win32 window presenting two evidence-equal children, shared by
//! the resolver's multi-candidate tests.
//!
//! The pair is the reproducible way an owned fixture presents duplicate
//! evidence (A17-3): both children carry the same class, the same text and the
//! same control id, so the UI Automation bridge publishes the same role, the
//! same `Name` and the same `AutomationId` for both. Only their rectangles are
//! the caller's to choose, which is what decides whether the bounds tie-break
//! has two equal hashes it cannot separate or two distinct ones it must pick
//! between.

use std::ffi::c_void;
use std::sync::mpsc::{Sender, channel};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use agent_desktop_core::{ElementIdentifier, IdentifierKind, LocatorEvidence};
use windows_sys::Win32::Foundation::HWND;
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::System::Threading::GetCurrentThreadId;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DestroyWindow, DispatchMessageW, GetMessageW, MSG, PostThreadMessageW,
    SW_SHOWNOACTIVATE, ShowWindow, TranslateMessage, WM_QUIT, WS_CHILD, WS_OVERLAPPEDWINDOW,
    WS_VISIBLE,
};

use crate::system::cursor_overlay::wide::wide;
use crate::tree::element::UIAElement;
use crate::tree::walk::walker::WalkBudget;
use crate::tree::walk::walker_source::UiaTreeSource;

/// Application-derived text the host puts on the wire so a redaction
/// regression has something to leak. A marker reaching an error's message,
/// suggestion, platform detail or details is app text the resolver had no
/// right to echo.
pub(crate) const NAME_MARKER: &str = "zzduplicatenamezz";
pub(crate) const TITLE_MARKER: &str = "zzduplicatetitlezz";
pub(crate) const APP_MARKER: &str = "zzduplicateappzz.exe";

/// The control id both children share, so the UI Automation bridge hands
/// both the same `AutomationId`.
const SHARED_CONTROL_ID: usize = 31337;
const CONTROL_BORDER: u32 = 0x0080_0000;
const CONTROL_LEFT: i32 = 8;
const CONTROL_TOP: i32 = 8;
const CONTROL_WIDTH: i32 = 200;
const CONTROL_HEIGHT: i32 = 24;
const CONTROL_GAP: i32 = 40;
const PAIR_WINDOW_WIDTH: i32 = 420;
const PAIR_WINDOW_HEIGHT: i32 = 220;
const READY_TIMEOUT: Duration = Duration::from_secs(30);
const WALKABLE_TIMEOUT: Duration = Duration::from_secs(20);
const WALKABLE_POLL: Duration = Duration::from_millis(100);

/// Where the pair's second child sits relative to the first.
#[derive(Clone, Copy)]
pub(crate) enum PairGeometry {
    /// One rectangle for both: the bounds tie-break is handed two equal
    /// hashes and no tier can separate the pair.
    Coincident,
    /// Two rectangles: the bounds tie-break is the only tier that separates
    /// the pair, and it must pick the stored one rather than the first.
    Separated,
}

impl PairGeometry {
    fn second_top(self) -> i32 {
        match self {
            Self::Coincident => CONTROL_TOP,
            Self::Separated => CONTROL_TOP + CONTROL_HEIGHT + CONTROL_GAP,
        }
    }
}

/// A window whose two children are indistinguishable to every identity tier:
/// same class, same text, same shared control id.
pub(crate) struct DuplicatePairWindow {
    pub(crate) handle: isize,
    thread_id: u32,
    host: Option<JoinHandle<()>>,
}

impl DuplicatePairWindow {
    pub(crate) fn create(geometry: PairGeometry) -> Result<Self, String> {
        let (sender, receiver) = channel();
        let host = std::thread::spawn(move || host_duplicate_pair(sender, geometry));
        let (handle, thread_id) = receiver
            .recv_timeout(READY_TIMEOUT)
            .map_err(|_| String::from("the duplicate-pair host never reported a window"))?;
        let hosted = Self {
            handle,
            thread_id,
            host: Some(host),
        };
        await_walkable(handle)?;
        Ok(hosted)
    }
}

impl Drop for DuplicatePairWindow {
    fn drop(&mut self) {
        unsafe { PostThreadMessageW(self.thread_id, WM_QUIT, 0, 0) };
        if let Some(host) = self.host.take() {
            let _ = host.join();
        }
    }
}

/// Creates the window and its duplicate pair on this thread and pumps until
/// told to quit.
///
/// The pump has to own the window and do nothing else: `ElementFromHandle`
/// sends `WM_GETOBJECT`, and a cross-thread `SendMessage` blocks until the
/// owning thread dispatches it, so a thread that both hosts the window and
/// waits on a UI Automation result deadlocks. Teardown posts `WM_QUIT` to the
/// thread rather than the window, so the window is destroyed by the thread
/// that created it.
fn host_duplicate_pair(ready: Sender<(isize, u32)>, geometry: PairGeometry) {
    let class = wide("#32770");
    let title = wide(TITLE_MARKER);
    let stage =
        crate::tree::fixture::offscreen_origin::stage(None, PAIR_WINDOW_WIDTH, PAIR_WINDOW_HEIGHT);
    let (left, top) = stage.origin();
    let window = unsafe {
        CreateWindowExW(
            0,
            class.as_ptr(),
            title.as_ptr(),
            WS_OVERLAPPEDWINDOW,
            left,
            top,
            PAIR_WINDOW_WIDTH,
            PAIR_WINDOW_HEIGHT,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            GetModuleHandleW(std::ptr::null()),
            std::ptr::null(),
        )
    };
    if window.is_null() {
        return;
    }
    duplicate_control(window, CONTROL_TOP);
    duplicate_control(window, geometry.second_top());
    unsafe { ShowWindow(window, SW_SHOWNOACTIVATE) };
    if ready
        .send((window as isize, unsafe { GetCurrentThreadId() }))
        .is_err()
    {
        unsafe { DestroyWindow(window) };
        return;
    }
    let mut message = MSG::default();
    while unsafe { GetMessageW(&mut message, std::ptr::null_mut(), 0, 0) } > 0 {
        unsafe { TranslateMessage(&message) };
        unsafe { DispatchMessageW(&message) };
    }
    unsafe { DestroyWindow(window) };
}

fn duplicate_control(parent: HWND, top: i32) {
    let class = wide("BUTTON");
    let text = wide(NAME_MARKER);
    unsafe {
        CreateWindowExW(
            0,
            class.as_ptr(),
            text.as_ptr(),
            WS_CHILD | WS_VISIBLE | CONTROL_BORDER,
            CONTROL_LEFT,
            top,
            CONTROL_WIDTH,
            CONTROL_HEIGHT,
            parent,
            SHARED_CONTROL_ID as *mut c_void,
            GetModuleHandleW(std::ptr::null()),
            std::ptr::null(),
        )
    };
}

/// Blocks until the window resolves to a UI Automation root, so a loaded
/// runner's first `WM_GETOBJECT` timing out is a wait rather than a failure.
fn await_walkable(handle: isize) -> Result<(), String> {
    let expiry = Instant::now() + WALKABLE_TIMEOUT;
    let mut last = String::from("the duplicate-pair window never resolved");
    while Instant::now() < expiry {
        let deadline =
            agent_desktop_core::Deadline::standard().map_err(|error| error.message.clone())?;
        match crate::tree::automation::root_from_hwnd(handle, deadline) {
            Ok(_) => return Ok(()),
            Err(error) => last = error.message.clone(),
        }
        std::thread::sleep(WALKABLE_POLL);
    }
    Err(last)
}

/// Collects the marked controls in the order the resolver's own search visits
/// them - same enumeration, same recursion - so a candidate's index here is
/// the index the search verdict will report.
pub(crate) fn collect_marked(
    source: &UiaTreeSource,
    element: &UIAElement,
    budget: &WalkBudget,
    out: &mut Vec<LocatorEvidence>,
) {
    crate::tree::walk::walker_fake::walk_all(
        source,
        element,
        budget,
        8,
        &mut |_prefix, evidence| {
            if evidence
                .name
                .known()
                .is_some_and(|name| name == NAME_MARKER)
            {
                out.push(evidence);
            }
        },
    );
}

pub(crate) fn automation_id(evidence: &LocatorEvidence) -> Option<ElementIdentifier> {
    evidence
        .identifiers
        .identifiers()
        .iter()
        .find(|identifier| matches!(identifier.kind, IdentifierKind::AutomationId))
        .cloned()
}
