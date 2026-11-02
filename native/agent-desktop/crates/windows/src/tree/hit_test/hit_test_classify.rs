//! Hit-element classification, the pre-probe guard ladder, and the budget the
//! ancestor walks are charged against.
//!
//! Self or descendant → `ReachesTarget`. Ancestor of the target → `Unknown`
//! directly: unlike macOS, UIA's `ElementFromPoint` is desktop-global with no
//! application-scoped retry, so the arm that would only refine toward
//! `Unknown` is the answer — Chromium render-host panes land here when web
//! content is not hit-addressable. Incomplete ancestry walks → `Unknown`.
//! Unrelated hits hand off to corroboration.
//!
//! Every ancestor step is a cross-process call, so the operation deadline is
//! consulted once per step and a truncated walk is `Incomplete` — the same
//! `Unknown` a failed step produces, never an interception on partial evidence.
//!
//! Rectangle membership is half-open on the right and bottom edges, the Win32
//! `RECT` convention the `07-hittest` probe used: a point on the virtual
//! screen's far edge addresses the first pixel outside it, and A18-6 measured
//! `ElementFromPoint` answering with the desktop at exactly such coordinates.

use crate::tree::properties::rect_has_area;
use crate::tree::walk::walker::{DEFAULT_MAX_RAW_DEPTH, NodeKey};
use agent_desktop_core::{Deadline, Point, Rect, adapter::hit_test::HitTestResult};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Ancestry {
    Found,
    Absent,
    Incomplete,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum HitClassification {
    ReachesTarget,
    AncestorOfTarget,
    Unrelated,
}

/// The pre-probe conditions that answer the hit test without probing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PreProbeGuard {
    ZeroArea,
    IconicRoot,
    OutsideVirtualScreen,
    OutsideTargetBounds,
}

impl PreProbeGuard {
    #[cfg(test)]
    pub(crate) const ALL: [Self; 4] = [
        Self::ZeroArea,
        Self::IconicRoot,
        Self::OutsideVirtualScreen,
        Self::OutsideTargetBounds,
    ];
}

/// The whole pre-probe ladder, over inputs the caller has already read.
/// `None` means the probe may run.
pub(crate) fn pre_probe_decision(
    bounds: &Rect,
    point: &Point,
    screen: &Rect,
    root_iconic: bool,
) -> Option<PreProbeGuard> {
    if !rect_has_area(bounds) {
        return Some(PreProbeGuard::ZeroArea);
    }
    if root_iconic {
        return Some(PreProbeGuard::IconicRoot);
    }
    if !point_in_rect(point, screen) || intersect_rects(*bounds, *screen).is_none() {
        return Some(PreProbeGuard::OutsideVirtualScreen);
    }
    if !point_in_rect(point, bounds) {
        return Some(PreProbeGuard::OutsideTargetBounds);
    }
    None
}

/// Every guard trip is absence of evidence: degenerate geometry is not
/// hit-testable, a minimized root's coordinates are stale, and a point off the
/// virtual screen is answered by the desktop. None of them invents an
/// interception.
pub(crate) fn result_for_guard(_guard: PreProbeGuard) -> HitTestResult {
    HitTestResult::Unknown
}

/// A walk the deadline truncated, a cycle, or a failed step all leave the
/// ancestor relation unproven, and an unproven relation is never an occluder.
pub(crate) fn result_for_incomplete_walk() -> HitTestResult {
    HitTestResult::Unknown
}

pub(crate) fn classify_relation(
    reaches_target: bool,
    is_ancestor_of_target: bool,
) -> HitClassification {
    if reaches_target {
        HitClassification::ReachesTarget
    } else if is_ancestor_of_target {
        HitClassification::AncestorOfTarget
    } else {
        HitClassification::Unrelated
    }
}

pub(crate) fn point_in_rect(point: &Point, bounds: &Rect) -> bool {
    point.x >= bounds.x
        && point.y >= bounds.y
        && point.x < bounds.x + bounds.width
        && point.y < bounds.y + bounds.height
}

pub(crate) fn intersect_rects(left: Rect, right: Rect) -> Option<Rect> {
    let x = left.x.max(right.x);
    let y = left.y.max(right.y);
    let right_edge = (left.x + left.width).min(right.x + right.width);
    let bottom_edge = (left.y + left.height).min(right.y + right.height);
    (right_edge > x && bottom_edge > y).then_some(Rect {
        x,
        y,
        width: right_edge - x,
        height: bottom_edge - y,
    })
}

/// Same-root demotion for unclipped provider rects (A18-2): a candidate point
/// outside `target ∩ nearest-scroll-viewport` must not become `InterceptedBy`
/// on a same-window neighbour. Corroboration applies it to the same-root arm
/// alone — a cross-window occluder two opinions agree on is real evidence.
pub(crate) fn should_demote_outside_viewport(
    point: &Point,
    target_bounds: &Rect,
    viewport: Option<&Rect>,
) -> bool {
    let Some(viewport) = viewport else {
        return false;
    };
    match intersect_rects(*target_bounds, *viewport) {
        Some(visible) => !point_in_rect(point, &visible),
        None => true,
    }
}

pub(crate) fn ancestry_limit() -> usize {
    DEFAULT_MAX_RAW_DEPTH as usize
}

/// One ancestor walk's per-step inputs: element comparison, keying for the
/// cycle guard, the parent step itself, and the budget every step is charged
/// against.
pub(crate) struct AncestryWalk<'a, N> {
    pub(crate) same_element: &'a dyn Fn(&N, &N) -> bool,
    pub(crate) identity: &'a dyn Fn(&N) -> NodeKey,
    pub(crate) parent_of: &'a dyn Fn(&N) -> Result<Option<N>, ()>,
    pub(crate) deadline: Deadline,
}

pub(crate) fn remember_ancestor_key<N: Clone>(
    visited_keys: &mut Vec<NodeKey>,
    visited_unkeyed: &mut Vec<N>,
    key: NodeKey,
    current: &N,
    same_element: &dyn Fn(&N, &N) -> bool,
) -> bool {
    match &key {
        NodeKey::Runtime(_) => {
            if visited_keys.iter().any(|seen| seen == &key) {
                return false;
            }
            visited_keys.push(key);
            true
        }
        NodeKey::Unavailable => {
            if visited_unkeyed
                .iter()
                .any(|seen| same_element(seen, current))
            {
                return false;
            }
            visited_unkeyed.push(current.clone());
            true
        }
    }
}

pub(crate) fn ancestry_with<N: Clone>(
    start: &N,
    expected: &N,
    limit: usize,
    walk: &AncestryWalk<'_, N>,
) -> Ancestry {
    let mut current = start.clone();
    let mut visited_keys = Vec::new();
    let mut visited_unkeyed = Vec::new();
    for _ in 0..limit {
        if walk.deadline.is_expired() {
            return Ancestry::Incomplete;
        }
        if !remember_ancestor_key(
            &mut visited_keys,
            &mut visited_unkeyed,
            (walk.identity)(&current),
            &current,
            walk.same_element,
        ) {
            return Ancestry::Incomplete;
        }
        let parent = match (walk.parent_of)(&current) {
            Ok(Some(parent)) => parent,
            Ok(None) => return Ancestry::Absent,
            Err(()) => return Ancestry::Incomplete,
        };
        if (walk.same_element)(&parent, expected) {
            return Ancestry::Found;
        }
        current = parent;
    }
    Ancestry::Incomplete
}

pub(crate) fn classify_hit_with<N: Clone>(
    target: &N,
    hit: &N,
    walk: &AncestryWalk<'_, N>,
) -> Option<HitClassification> {
    let limit = ancestry_limit();
    let reaches_target = if (walk.same_element)(target, hit) {
        Ancestry::Found
    } else {
        ancestry_with(hit, target, limit, walk)
    };
    if reaches_target == Ancestry::Incomplete {
        return None;
    }
    let is_ancestor_of_target = if reaches_target == Ancestry::Found {
        Ancestry::Absent
    } else {
        ancestry_with(target, hit, limit, walk)
    };
    if is_ancestor_of_target == Ancestry::Incomplete {
        return None;
    }
    Some(classify_relation(
        reaches_target == Ancestry::Found,
        is_ancestor_of_target == Ancestry::Found,
    ))
}
