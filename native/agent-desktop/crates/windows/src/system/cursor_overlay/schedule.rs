//! When to sample the cursor's pose, and when it has arrived.
//!
//! Pure. Core owns the trajectory — `CursorMotion` is a function of elapsed
//! milliseconds — so the renderer's job is to decide when to ask, not where
//! the cursor is. A dropped frame therefore changes smoothness and never the
//! arrival instant, and arrival is answered by elapsed time rather than by a
//! frame count.
//!
//! The refresh reading is clamped rather than trusted. `GetDeviceCaps`
//! answers `VREFRESH` for the screen DC, but the value is a driver's report:
//! a zero would produce an infinite frame rate and an absurd value would
//! produce a budget the paint cannot meet. Both ends are bounded here so no
//! caller has to remember to.

use std::time::Duration;

/// Below this, a reading is treated as absent. Some drivers report 0 or 1 for
/// "unknown" rather than failing.
const MIN_REFRESH_HZ: u32 = 24;
const MAX_REFRESH_HZ: u32 = 240;
const FALLBACK_REFRESH_HZ: u32 = 60;

/// How long the highlight around a clicked element takes to fade in, in
/// fractions of its hold. macOS plays an opacity keyframe rather than showing
/// a static box, so a Windows outline that blinked on and off would read as a
/// visibly cruder cue.
const HIGHLIGHT_RISE: f64 = 0.08;
const HIGHLIGHT_FALL: f64 = 0.35;

pub(crate) fn frame_interval(reported_hz: u32) -> Duration {
    let hz = clamp_refresh(reported_hz);
    Duration::from_nanos(1_000_000_000 / u64::from(hz))
}

pub(crate) fn clamp_refresh(reported_hz: u32) -> u32 {
    if reported_hz < MIN_REFRESH_HZ {
        return FALLBACK_REFRESH_HZ;
    }
    reported_hz.min(MAX_REFRESH_HZ)
}

/// Whether the travel is over, given how long it has been running and how
/// long core said it would take. A motion with nowhere to go arrives at once,
/// so a click on the cursor's current position does not wait.
pub(crate) fn has_arrived(elapsed_ms: u64, motion_duration_ms: u64) -> bool {
    elapsed_ms >= motion_duration_ms
}

/// The highlight's opacity across its hold: it rises, holds, and falls.
/// Returns zero before it starts and after it ends, so a caller can drive the
/// whole life of the cue from one number.
pub(crate) fn highlight_progress(elapsed_ms: u64, hold_ms: u64) -> f64 {
    if hold_ms == 0 || elapsed_ms >= hold_ms {
        return 0.0;
    }
    let fraction = elapsed_ms as f64 / hold_ms as f64;
    if fraction < HIGHLIGHT_RISE {
        return fraction / HIGHLIGHT_RISE;
    }
    if fraction > 1.0 - HIGHLIGHT_FALL {
        return (1.0 - fraction) / HIGHLIGHT_FALL;
    }
    1.0
}

#[cfg(test)]
#[path = "schedule_tests.rs"]
mod tests;

/// The label card's opacity as it appears, on an ease-out curve.
///
/// A card that blinked to full strength reads as a glitch rather than as
/// something arriving; macOS ramps its opacity over the same span with Core
/// Animation's ease-out, and `1 - (1 - t)^3` is that curve closely enough to
/// be indistinguishable at this duration. The card reads as fully present once the reveal is
/// over, so a caller can drive the whole life of the card from one number
/// and stop asking after it settles.
pub(crate) fn reveal_progress(elapsed_ms: u64, duration_ms: u64) -> f64 {
    if duration_ms == 0 || elapsed_ms >= duration_ms {
        return 1.0;
    }
    let remaining = 1.0 - (elapsed_ms as f64 / duration_ms as f64);
    1.0 - remaining * remaining * remaining
}

/// The opacity of the whole overlay at one step of the rest fade.
///
/// Linear, matching the reference, which steps its window alpha down in even
/// hops rather than easing. Easing the disappearance would draw attention to
/// it, which is the opposite of what resting is for.
pub(crate) fn rest_fade(step: u32, steps: u32) -> f64 {
    if steps == 0 {
        return 0.0;
    }
    let remaining = steps.saturating_sub(step);
    f64::from(remaining) / f64::from(steps)
}
