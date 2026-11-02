//! Runner-relative fixture parking.
//!
//! A fixed off-screen constant is off-screen only by accident of whichever
//! box happens to run the suite. This module reads the virtual-screen rect at
//! call time (or accepts one injected for a test) and resolves a park point
//! outside it; when no such point exists within the bounded reach this module
//! is willing to take, the caller must hold the serialized on-screen stage
//! instead of guessing at an unserialized position inside a live desktop.

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Mutex, MutexGuard};

/// Gap left between the virtual-screen edge and a parked window's near edge.
const OFFSCREEN_INSET: i32 = 48;

/// How far past the virtual-screen edge a parked window may sit.
///
/// This is an engineering reach bound, not a fact about any one box: a park
/// point this far out clears every display arrangement this crate's own
/// fixtures are exercised against, while staying short enough that an
/// injected rect can exercise the on-screen fallback without needing a
/// contrived, near-`i32::MAX` rect.
const MAX_OFFSCREEN_SPAN: i32 = 3_000;

/// The bounding rectangle of every display, in the units `CreateWindowExW`
/// takes. Left/top may be negative when a secondary display sits above or to
/// the left of the primary.
#[derive(Debug, Clone, Copy)]
pub(crate) struct VirtualScreenRect {
    pub(crate) left: i32,
    pub(crate) top: i32,
    pub(crate) width: i32,
    pub(crate) height: i32,
}

impl VirtualScreenRect {
    pub(crate) fn right(self) -> i32 {
        self.left + self.width
    }

    pub(crate) fn bottom(self) -> i32 {
        self.top + self.height
    }

    pub(crate) fn contains(self, x: i32, y: i32) -> bool {
        x >= self.left && x < self.right() && y >= self.top && y < self.bottom()
    }
}

fn live_virtual_screen_rect() -> VirtualScreenRect {
    let (left, top, width, height) = crate::tree::hit_test::virtual_screen_metrics();
    VirtualScreenRect {
        left,
        top,
        width,
        height,
    }
}

fn fits_within_reach(origin: i32, extent: i32) -> bool {
    match origin.checked_add(extent) {
        Some(edge) => edge <= MAX_OFFSCREEN_SPAN,
        None => false,
    }
}

/// Resolves a point outside `rect` for a window of `window_width` by
/// `window_height`, or `None` when no such point exists within this module's
/// bounded reach.
///
/// Two candidates are tried, each disjoint from `rect` on a single axis so
/// neither depends on the other axis fitting: to the right of the rect (its
/// x-range clears every display's x-range regardless of y), then below it
/// (its y-range clears every display's y-range regardless of x). A rect wide
/// enough to defeat the first candidate is common on an ordinary side-by-side
/// dual-monitor box, which is exactly why the second candidate exists rather
/// than requiring both axes to clear at once.
pub(crate) fn resolve_offscreen_origin(
    rect: VirtualScreenRect,
    window_width: i32,
    window_height: i32,
) -> Option<(i32, i32)> {
    if let Some(x) = rect.right().checked_add(OFFSCREEN_INSET) {
        if fits_within_reach(x, window_width) {
            return Some((x, rect.top));
        }
    }
    if let Some(y) = rect.bottom().checked_add(OFFSCREEN_INSET) {
        if fits_within_reach(y, window_height) {
            return Some((rect.left, y));
        }
    }
    None
}

/// Serializes the live legs that stage on-screen windows and then read the
/// desktop's z-order.
///
/// Slot rotation alone is not enough: the slot counter wraps once placements
/// exceed the display's slot grid, and a short or remote display can offer
/// only one row, so two parallel legs can hold the same rect. Even on distinct
/// rects the legs are not independent — one of them deliberately raises a
/// topmost window over a point a neighbour is about to probe.
///
/// The legs read Win32's opinion of their point on both sides of the probe, so
/// a neighbour moving the z-order underneath one cannot make it assert against
/// a desktop it never saw; what it can still do is own the point on both
/// readings, which turns the leg's assertion into an honest skip and takes the
/// coverage with it. Holding this while a leg stages and probes is what keeps
/// those assertions running rather than merely truthful.
///
/// A poisoned lock is adopted rather than propagated: the mutex guards screen
/// real estate, not data, so one failing leg must not cascade into every other
/// leg reporting a lock error instead of its own verdict.
pub(crate) fn on_screen_stage() -> MutexGuard<'static, ()> {
    static STAGE: Mutex<()> = Mutex::new(());
    STAGE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// An origin inset inside the virtual screen so live hit-test fixtures clear
/// the virtual-screen membership guard. Each call advances a slot so parallel
/// live tests do not park on the same screen rect (A18-4 foreign-window
/// contamination shape). Slot pitch and wrap keep the full window rect inside
/// the virtual screen — a tall-slot layout on a short display would park below
/// the fold and the hit-test guard would honestly answer `Unknown`.
pub(crate) fn on_screen_origin() -> (i32, i32) {
    use crate::tree::fixture::fixture_window::{WINDOW_HEIGHT, WINDOW_WIDTH};
    const INSET: i32 = 48;
    let slot_dx = WINDOW_WIDTH + 24;
    let slot_dy = WINDOW_HEIGHT + 24;
    static SLOT: AtomicU32 = AtomicU32::new(0);
    let rect = live_virtual_screen_rect();
    let cols = ((rect.width - INSET * 2 - WINDOW_WIDTH).max(0) / slot_dx + 1).max(1);
    let rows = ((rect.height - INSET * 2 - WINDOW_HEIGHT).max(0) / slot_dy + 1).max(1);
    let slot = SLOT.fetch_add(1, Ordering::SeqCst) as i32;
    let col = slot % cols;
    let row = (slot / cols) % rows;
    (
        rect.left + INSET + col * slot_dx,
        rect.top + INSET + row * slot_dy,
    )
}

/// Which stage a parking decision took: an unserialized off-screen point, or
/// the serialized on-screen stage held for as long as the returned guard
/// lives.
#[derive(Debug)]
pub(crate) enum Stage {
    Parked {
        origin: (i32, i32),
    },
    OnScreen {
        origin: (i32, i32),
        guard: MutexGuard<'static, ()>,
    },
}

impl Stage {
    pub(crate) fn origin(&self) -> (i32, i32) {
        match self {
            Stage::Parked { origin } | Stage::OnScreen { origin, .. } => *origin,
        }
    }
}

/// The staging entry point: resolves where a fixture window of
/// `window_width` by `window_height` may go, taking the on-screen stage when
/// no off-screen point exists within reach rather than ever parking inside
/// the desktop unserialized.
///
/// `rect` defaults to the live virtual-screen rect; a test injects one to
/// exercise the fallback without a second monitor.
pub(crate) fn stage(
    rect: Option<VirtualScreenRect>,
    window_width: i32,
    window_height: i32,
) -> Stage {
    let rect = rect.unwrap_or_else(live_virtual_screen_rect);
    match resolve_offscreen_origin(rect, window_width, window_height) {
        Some(origin) => Stage::Parked { origin },
        None => {
            let guard = on_screen_stage();
            let origin = on_screen_origin();
            Stage::OnScreen { origin, guard }
        }
    }
}

#[cfg(test)]
#[path = "offscreen_origin_tests.rs"]
mod tests;
