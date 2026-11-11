//! Window-attribution corroboration and occluder evidence for hit testing.
//!
//! `InterceptedBy` requires two-opinion agreement: the UIA hit element's root
//! and `WindowFromPoint`→`GA_ROOT` must agree on the window question before an
//! unrelated hit is named. Transparent / disabled overlays that Win32
//! documented-skips toward the target's root against a differing hit root are
//! designed `Unknown` (A18-4). Same-root overlays are named on UIA's verdict
//! alone when both roots equal the target's (A18-4: same-root was not
//! live-proven on the probe desktop due to foreign-window contamination; the
//! designed rule and fixture live test still ship).
//!
//! The unclipped-provider-rect demotion (A18-2) lands here rather than ahead of
//! the seam, because it answers a same-window question: an unclipped rect puts
//! candidate points over neighbours that share the target's root. It therefore
//! silences the same-root arm only — a cross-window occluder both opinions
//! agree on is evidence, not noise, wherever the point falls.
//!
//! Both root walks and the evidence batch are cross-process, so each consults
//! the operation deadline; an expired budget answers `Unknown` before the
//! attribution decision, so a truncated hit-root walk can never widen into the
//! pid arm on evidence that was merely unread.
//!
//! A18-4's elevated High-over-Medium occluder leg was not measured on this
//! box (token privilege denied). Cross-integrity occluder reads therefore
//! rest on A9-2 / A16-12 observation-across-boundary evidence until an
//! elevated A18 capture lands — not a product-path blocker.

use agent_desktop_core::{Deadline, LocatorField, Point, adapter::hit_test::HitTestResult};
use uiautomation::core::UITreeWalker;

use super::classify::ancestry_limit;
use super::imp::saturate_coord;
use crate::tree::element::UIAElement;
use crate::tree::name_evidence::{LabelOutcome, name_fields, read_label};
use crate::tree::properties::element_properties::ElementProperties;
use crate::tree::properties::property_ids::TreeProperty;
use crate::tree::properties::property_outcome::PropertyOutcome;
use crate::tree::properties::read_one;
use crate::tree::roles::resolve_role;
use crate::tree::walk::walker_source::BudgetExpired;
use crate::tree::walk::walker_source::parent_step;

/// Properties the occluder evidence batch must read together. `IsPassword`
/// gates value-bearing text in [`ElementProperties::from_reads`]; omitting it
/// would leave the secure-field withhold open.
pub(crate) const OCCLUDER_EVIDENCE_PROPERTIES: &[TreeProperty] = &[
    TreeProperty::IsPassword,
    TreeProperty::Name,
    TreeProperty::HelpText,
    TreeProperty::FullDescription,
    TreeProperty::ControlType,
    TreeProperty::BoundingRectangle,
];

/// What one corroboration decision reads. The target's root arrives already
/// resolved: the pre-probe `IsIconic` guard asks the same question of the same
/// walk, and repeating it would spend a second cross-process ancestor climb
/// per hit test. The hit element's root is always resolved here, since
/// agreement between two independent opinions is the entire evidence.
pub(crate) struct InterceptionContext<'a> {
    pub(crate) target: &'a UIAElement,
    pub(crate) target_root: Option<isize>,
    pub(crate) hit: &'a UIAElement,
    pub(crate) point: Point,
    pub(crate) walker: &'a UITreeWalker,
    pub(crate) deadline: Deadline,
}

/// Which window the two opinions agree owns the point.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Attribution {
    SameRoot,
    CrossWindow,
    Contradicted,
}

/// One window as a single opinion reports it: the root handle that opinion
/// resolved, and the process owning it. The two travel together because they
/// describe the same window, and separating them into parallel argument lists
/// is what lets a caller transpose one window's pid onto another's root.
#[derive(Debug, Clone, Copy)]
pub(crate) struct WindowOpinion {
    pub(crate) root: Option<isize>,
    pub(crate) pid: Option<u32>,
}

/// Pure window-attribution decision over the target's, hit's, and
/// `WindowFromPoint`'s opinions; evidence is assembled separately.
pub(crate) fn interception_attribution(
    target: WindowOpinion,
    hit: WindowOpinion,
    win32: WindowOpinion,
) -> Attribution {
    let Some(target_root) = nonzero(target.root) else {
        return Attribution::Contradicted;
    };
    let Some(win32_root) = nonzero(win32.root) else {
        return Attribution::Contradicted;
    };
    match nonzero(hit.root) {
        Some(hit_root) if hit_root == target_root && win32_root == target_root => {
            Attribution::SameRoot
        }
        Some(hit_root)
            if hit_root != target_root && win32_root != target_root && win32_root == hit_root =>
        {
            Attribution::CrossWindow
        }
        Some(_) => Attribution::Contradicted,
        None => pid_widened(target_root, win32_root, target.pid, hit.pid, win32.pid),
    }
}

/// pid difference proves two windows belong to different processes; pid
/// equality never proves same-window, so equality widens nothing.
fn pid_widened(
    target: isize,
    win32: isize,
    target_pid: Option<u32>,
    hit_pid: Option<u32>,
    win32_owner_pid: Option<u32>,
) -> Attribution {
    let widens = matches!(
        (target_pid, hit_pid, win32_owner_pid),
        (Some(target_pid), Some(hit_pid), Some(win32_pid))
            if win32 != target && hit_pid != target_pid && hit_pid == win32_pid
    );
    if widens {
        Attribution::CrossWindow
    } else {
        Attribution::Contradicted
    }
}

/// The reportable outcome for an attribution. Only the same-root arm answers
/// to the viewport demotion (A18-2), and unassembled evidence is `Unknown`.
pub(crate) fn interception_outcome(
    attribution: Attribution,
    demote_for_viewport: bool,
    evidence: impl FnOnce() -> Option<HitTestResult>,
) -> HitTestResult {
    match attribution {
        Attribution::Contradicted => HitTestResult::Unknown,
        Attribution::SameRoot if demote_for_viewport => HitTestResult::Unknown,
        Attribution::SameRoot | Attribution::CrossWindow => {
            evidence().unwrap_or(HitTestResult::Unknown)
        }
    }
}

fn nonzero(handle: Option<isize>) -> Option<isize> {
    handle.filter(|&value| value != 0)
}

/// Walks to the first non-zero `NativeWindowHandle`, then `GA_ROOT`.
pub(crate) fn element_root_hwnd(
    start: &UIAElement,
    walker: &UITreeWalker,
    deadline: Deadline,
) -> Result<Option<isize>, BudgetExpired> {
    Ok(first_native_hwnd(start, walker, deadline)?.and_then(root_of_hwnd))
}

/// Climbs to the first ancestor reporting a non-zero window handle.
///
/// `Ok(None)` means the climb completed and no ancestor owns a window -
/// the ordinary shape for WPF, WinUI and Chromium content, where one
/// window hosts a whole tree. `Err(BudgetExpired)` means the climb could
/// not be completed: a handle read faulted, a parent step faulted, or the
/// budget ran out between two cross-process calls. Folding those together
/// let a caller read a failed read as "this element has no window", which
/// is licence it should never have had.
pub(crate) fn first_native_hwnd(
    start: &UIAElement,
    walker: &UITreeWalker,
    deadline: Deadline,
) -> Result<Option<isize>, BudgetExpired> {
    use windows::Win32::Foundation::HWND;

    let mut current = start.clone();
    for _ in 0..ancestry_limit() {
        if deadline.is_expired() {
            return Err(BudgetExpired);
        }
        match current.0.get_native_window_handle() {
            Ok(handle) => {
                let hwnd: HWND = handle.into();
                let value = hwnd.0 as isize;
                if value != 0 {
                    return Ok(Some(value));
                }
            }
            Err(_) => return Err(BudgetExpired),
        }
        match parent_step(walker, &current) {
            Ok(Some(parent)) => current = parent,
            Ok(None) => return Ok(None),
            Err(()) => return Err(BudgetExpired),
        }
    }
    Ok(None)
}

pub(crate) fn root_of_hwnd(hwnd: isize) -> Option<isize> {
    use windows_sys::Win32::UI::WindowsAndMessaging::{GA_ROOT, GetAncestor};

    if hwnd == 0 {
        return None;
    }
    let root = unsafe { GetAncestor(hwnd as *mut std::ffi::c_void, GA_ROOT) };
    if root.is_null() {
        None
    } else {
        Some(root as isize)
    }
}

pub(crate) fn window_from_point_root(point: &Point) -> Option<isize> {
    use windows_sys::Win32::Foundation::POINT;
    use windows_sys::Win32::UI::WindowsAndMessaging::WindowFromPoint;

    let physical = POINT {
        x: saturate_coord(point.x),
        y: saturate_coord(point.y),
    };
    let hwnd = unsafe { WindowFromPoint(physical) };
    if hwnd.is_null() {
        return None;
    }
    root_of_hwnd(hwnd as isize)
}

pub(crate) fn pid_of_hwnd(hwnd: isize) -> Option<u32> {
    if hwnd == 0 {
        return None;
    }
    crate::system::window::window_identity::live_window_owner(hwnd as *mut std::ffi::c_void)
        .map(u32::from)
}

fn process_id_of(element: &UIAElement) -> Option<u32> {
    element.0.get_process_id().ok().filter(|&pid| pid != 0)
}

/// Assembles occluder evidence from the hit element. Returns `None` when a
/// required evidence read failed (bounds unread), so the caller demotes to
/// `Unknown`. A spent budget skips the label relation the way the live
/// element read does — `Failed`, never `Unlabelled`, since nothing was asked.
pub(crate) fn occluder_evidence(hit: &UIAElement, deadline: Deadline) -> Option<HitTestResult> {
    let properties = read_occluder_properties(hit, deadline);
    let label = if deadline.is_expired() {
        LabelOutcome::Failed
    } else {
        read_label(hit, false)
    };
    occluder_from_properties(&properties, label)
}

/// Builds `InterceptedBy` from a prepared property set (tests pin withholding
/// and the `"unknown"` role fallback without a live probe).
pub(crate) fn occluder_from_properties(
    properties: &ElementProperties,
    label: LabelOutcome,
) -> Option<HitTestResult> {
    let role = occluder_role(properties);
    let (name_field, _) = name_fields(properties, &label);
    let name = name_field.known().cloned();
    let bounds = match properties.get(TreeProperty::BoundingRectangle).bounds() {
        LocatorField::Known(bounds) => Some(bounds),
        LocatorField::Absent => None,
        LocatorField::Unknown => return None,
    };
    Some(HitTestResult::InterceptedBy {
        role: Some(role),
        name,
        bounds,
    })
}

/// An expired budget truncates the batch the way the walk property set is
/// truncated: the unread properties classify `Unknown`, unread bounds fail the
/// evidence, and the interception is not named.
fn read_occluder_properties(hit: &UIAElement, deadline: Deadline) -> ElementProperties {
    let reads = OCCLUDER_EVIDENCE_PROPERTIES
        .iter()
        .copied()
        .map(|property| {
            let outcome = if deadline.is_expired() {
                PropertyOutcome::Unknown
            } else {
                read_one(hit, property)
            };
            (property, outcome)
        })
        .collect();
    ElementProperties::from_reads(reads)
}

fn occluder_role(properties: &ElementProperties) -> String {
    match resolve_role(properties) {
        LocatorField::Known(role) => role,
        LocatorField::Absent | LocatorField::Unknown => "unknown".to_string(),
    }
}

/// The element pids are read only when the hit element's root is unobtainable,
/// which is the sole arm that consults them. `CurrentProcessId` is a
/// cross-process call, so reading the pair unconditionally spent two of them per
/// hit test on evidence the decision then discarded.
pub(crate) fn corroborate_interception(
    context: &InterceptionContext<'_>,
    demote_for_viewport: bool,
) -> HitTestResult {
    let Ok(hit_root) = element_root_hwnd(context.hit, context.walker, context.deadline) else {
        return super::classify::result_for_incomplete_walk();
    };
    let win32_root = window_from_point_root(&context.point);
    let win32_owner_pid = win32_root.and_then(pid_of_hwnd);
    if context.deadline.is_expired() {
        return HitTestResult::Unknown;
    }
    let widens = nonzero(hit_root).is_none();
    let attribution = interception_attribution(
        WindowOpinion {
            root: context.target_root,
            pid: widens.then(|| process_id_of(context.target)).flatten(),
        },
        WindowOpinion {
            root: hit_root,
            pid: widens.then(|| process_id_of(context.hit)).flatten(),
        },
        WindowOpinion {
            root: win32_root,
            pid: win32_owner_pid,
        },
    );
    interception_outcome(attribution, demote_for_viewport, || {
        occluder_evidence(context.hit, context.deadline)
    })
}

#[cfg(test)]
#[path = "hit_test_corroborate_tests.rs"]
mod tests;

/// Split from `hit_test_corroborate_tests.rs`: this module owns the cases
/// that drive a live fixture and a real walker to tell an incomplete climb
/// apart from a completed one that found no window.
#[cfg(test)]
#[cfg(target_os = "windows")]
#[path = "hit_test_corroborate_climb_tests.rs"]
mod climb_tests;
