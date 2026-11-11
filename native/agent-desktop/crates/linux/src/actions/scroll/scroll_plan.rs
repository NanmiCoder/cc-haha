use std::time::Duration;

use crate::system::process::toolkit_id::ToolkitId;
use crate::tree::Extents;

/// How long a scroll is watched for before it is judged not to have moved the
/// target. A `Value` write to the Files scroll bar realised its virtualised
/// rows about 1.3 s later (L23-24) and a write to a GTK3 scrolled window's
/// bar 0.53 s later (L27-4), so a read at 0.6 s would call a working write a
/// failure.
pub(crate) const OBSERVE_WINDOW: Duration = Duration::from_millis(2_000);

/// The gap between two looks at the target while a scroll is watched.
pub(crate) const POLL_INTERVAL: Duration = Duration::from_millis(100);

/// The most `Value` writes one call makes while the target stays off screen.
pub(crate) const MAX_WRITES: usize = 4;

/// One way of asking a toolkit to bring a node into view.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Rung {
    ScrollTo,
    BarValue,
}

impl Rung {
    pub(crate) fn name(self) -> &'static str {
        match self {
            Self::ScrollTo => "scroll_to",
            Self::BarValue => "scroll_bar_value",
        }
    }
}

const SCROLL_TO_THEN_BAR: &[Rung] = &[Rung::ScrollTo, Rung::BarValue];
const BAR_ONLY: &[Rung] = &[Rung::BarValue];

/// L41-24: do not move content when its viewport is not contained on one display:
/// reaching the scrollbar limit then cannot establish target visibility.
pub(crate) fn viewport_clipped(placed: &crate::tree::placement::Placement) -> bool {
    let (Some(rect), Some(window), Some(displays)) =
        (placed.container, placed.x11, &placed.displays)
    else {
        return false;
    };
    if rect.width <= 0
        || rect.height <= 0
        || rect.x == i32::MIN
        || rect.y == i32::MIN
        || displays.is_empty()
        || displays.iter().any(|d| d.width <= 0 || d.height <= 0)
    {
        return false;
    }
    let x = i64::from(rect.x) + i64::from(window.client_origin.0) + i64::from(window.shadow.0);
    let y = i64::from(rect.y) + i64::from(window.client_origin.1) + i64::from(window.shadow.1);
    !displays.iter().any(|d| {
        x >= i64::from(d.x)
            && y >= i64::from(d.y)
            && x + i64::from(rect.width) <= i64::from(d.x) + i64::from(d.width)
            && y + i64::from(rect.height) <= i64::from(d.y) + i64::from(d.height)
    })
}

/// The rungs worth trying on a toolkit, in order. `Component.ScrollTo`
/// answers false for every GTK call measured (L27-5), so GTK goes straight to
/// the bar; Chromium's `ScrollTo` moved the page (L27-5). Qt answers
/// `UnknownObject` to `ScrollTo` and exposes no bar, so both rungs end in a
/// refusal there, tried rather than assumed. A toolkit nobody measured gets
/// both rungs.
pub(crate) fn rungs_for(toolkit: &ToolkitId) -> &'static [Rung] {
    match toolkit.name.as_deref() {
        Some(name) if name.eq_ignore_ascii_case("gtk") => BAR_ONLY,
        _ => SCROLL_TO_THEN_BAR,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Axis {
    Vertical,
    Horizontal,
}

/// A scroll bar's range, in the pixels a toolkit adjustment counts.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct BarRange {
    pub(crate) min: f64,
    pub(crate) max: f64,
    pub(crate) current: f64,
}

/// Where the target is, as far as it can be told.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Aim {
    /// The target's own rectangle in window coordinates.
    Rect(Extents),
    /// The target has no position; it sits `delta` places after (positive) or
    /// before a sibling that is showing. `unit` is that sibling's length along
    /// the axis and `anchor` how far its start is from the viewport start.
    Index {
        delta: i64,
        unit: Option<i64>,
        anchor: i64,
    },
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) enum Step {
    Write(f64),
    AtLimit,
}

fn start_of(rect: Extents, axis: Axis) -> i64 {
    match axis {
        Axis::Vertical => i64::from(rect.y),
        Axis::Horizontal => i64::from(rect.x),
    }
}

fn length_of(rect: Extents, axis: Axis) -> i64 {
    match axis {
        Axis::Vertical => i64::from(rect.height),
        Axis::Horizontal => i64::from(rect.width),
    }
}

fn gap_past(rect: Extents, around: Extents, axis: Axis) -> i64 {
    let (start, length) = (start_of(rect, axis), length_of(rect, axis));
    let (from, span) = (start_of(around, axis), length_of(around, axis));
    (start - (from + span)).max(from - (start + length))
}

/// The axis the target is off along: horizontal only when it clears the
/// viewport sideways while overlapping it vertically.
pub(crate) fn axis_of(target: Option<Extents>, viewport: Option<Extents>) -> Axis {
    let (Some(target), Some(viewport)) = (positive(target), positive(viewport)) else {
        return Axis::Vertical;
    };
    let sideways = gap_past(target, viewport, Axis::Horizontal) > 0;
    let vertically = gap_past(target, viewport, Axis::Vertical) > 0;
    if sideways && !vertically {
        Axis::Horizontal
    } else {
        Axis::Vertical
    }
}

fn positive(rect: Option<Extents>) -> Option<Extents> {
    rect.filter(|rect| {
        rect.width > 0 && rect.height > 0 && rect.x != i32::MIN && rect.y != i32::MIN
    })
}

/// Where the target is, from its own rectangle when it has one and otherwise
/// from a sibling that is showing and how many places apart they are.
pub(crate) fn aim_for(
    target: Option<Extents>,
    neighbour: Option<(i64, Extents)>,
    axis: Axis,
    viewport: Extents,
) -> Option<Aim> {
    if let Some(target) = positive(target) {
        return Some(Aim::Rect(target));
    }
    let (delta, sibling) = neighbour?;
    let unit = length_of(sibling, axis);
    Some(Aim::Index {
        delta,
        unit: (unit > 0).then_some(unit),
        anchor: start_of(sibling, axis) - start_of(viewport, axis),
    })
}

/// The value to write so the target's start meets the viewport's start,
/// clamped to the bar's range, or `AtLimit` when the write would not move the
/// bar. A target with no position moves by its sibling distance in units, or
/// by one viewport page when the unit is unknown.
pub(crate) fn next_value(range: BarRange, viewport: Extents, axis: Axis, aim: Aim) -> Step {
    let page = length_of(viewport, axis);
    let travel = match aim {
        Aim::Rect(target) => start_of(target, axis) - start_of(viewport, axis),
        Aim::Index {
            delta,
            unit: Some(unit),
            anchor,
        } if unit > 0 => delta.saturating_mul(unit).saturating_add(anchor),
        Aim::Index { delta, .. } => delta.signum().saturating_mul(page),
    };
    let wanted = (range.current + travel as f64).clamp(range.min, range.max);
    if (wanted - range.current).abs() < 0.5 {
        Step::AtLimit
    } else {
        Step::Write(wanted)
    }
}
