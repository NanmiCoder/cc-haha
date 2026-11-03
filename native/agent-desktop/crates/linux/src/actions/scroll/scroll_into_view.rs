use agent_desktop_core::{
    AdapterError, DeliverySemantics, ErrorCode, InteractionLease, NativeHandle,
};
use serde_json::json;

use super::scroll_bus::BusPort;
use super::scroll_observe::{Clock, Waiter, realised};
use super::scroll_plan::{
    Axis, BarRange, MAX_WRITES, OBSERVE_WINDOW, POLL_INTERVAL, Rung, Step, aim_for, axis_of,
    next_value, rungs_for,
};
use crate::system::SharedBus;
use crate::system::focus::focus_cause::{Cause as FocusCause, refusal};
use crate::system::process::toolkit_id::ToolkitId;
use crate::tree::{Extents, atspi_element};

/// What the target reads as before anything is tried.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct View {
    pub(crate) offscreen: Option<bool>,
    pub(crate) hidden: bool,
    pub(crate) window_minimized: bool,
    pub(crate) bounds_provable: bool,
}

/// Where the target, its scroll container and its window are, in window
/// coordinates, and the nearest sibling that is showing (places apart and
/// rectangle) for a target without a position of its own.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub(crate) struct Geometry {
    pub(crate) target: Option<Extents>,
    pub(crate) container: Option<Extents>,
    pub(crate) frame: Option<Extents>,
    pub(crate) neighbour: Option<(i64, Extents)>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum BarFound {
    Found { extents: Option<Extents> },
    Missing { container: bool },
}

/// The reads and writes a scroll needs. The adapter implements it over the
/// accessibility bus; a test scripts it.
pub(crate) trait ScrollPort {
    fn toolkit(&mut self) -> ToolkitId;
    fn view(&mut self) -> Result<View, AdapterError>;
    /// The target's derived `offscreen`, read fresh.
    fn observe(&mut self) -> Result<Option<bool>, AdapterError>;
    /// `Component.ScrollTo`: whether the toolkit said it did something.
    fn scroll_to(&mut self) -> Result<bool, AdapterError>;
    fn geometry(&mut self) -> Result<Geometry, AdapterError>;
    fn find_bar(&mut self, axis: Axis) -> Result<BarFound, AdapterError>;
    fn range(&mut self) -> Result<Option<BarRange>, AdapterError>;
    fn write(&mut self, value: f64) -> Result<(), AdapterError>;
}

/// Why a scroll ended without the target on screen, weakest cause first: a
/// later cause is more specific than an earlier one and replaces it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Cause {
    NoRoute,
    NoContainer,
    NoBar,
    CannotAim,
    AtLimit,
    NotRealised,
    TargetHidden,
    BoundsNotProvable,
    VisibilityUnknown,
}

impl Cause {
    fn name(self) -> &'static str {
        match self {
            Self::NoRoute => "no_scroll_route",
            Self::NoContainer => "no_scroll_container",
            Self::NoBar => "no_scroll_bar",
            Self::CannotAim => "target_position_unknown",
            Self::AtLimit => "scroll_bar_at_limit",
            Self::NotRealised => "target_not_realised",
            Self::TargetHidden => "target_hidden",
            Self::BoundsNotProvable => "bounds_not_provable",
            Self::VisibilityUnknown => "target_visibility_unknown",
        }
    }

    fn message(self) -> &'static str {
        match self {
            Self::NoRoute => "No way of scrolling this element into view is known",
            Self::NoContainer => "The element has no scroll container to scroll",
            Self::NoBar => "The scroll container exposes no scroll bar that moves content",
            Self::CannotAim => "The element's position in its scroll container could not be read",
            Self::AtLimit => {
                "The scroll bar is already at its limit and the element is still off screen"
            }
            Self::NotRealised => "The element was still off screen after the scroll was attempted",
            Self::TargetHidden => "The element is hidden and cannot be scrolled into view",
            Self::BoundsNotProvable => {
                "The element is on screen but its position cannot be proved to a pointer"
            }
            Self::VisibilityUnknown => {
                "The element's visibility could not be proved, so no scroll was attempted"
            }
        }
    }
}

fn failure(cause: Cause, tried: &[&str]) -> AdapterError {
    let code = if cause == Cause::NoContainer {
        ErrorCode::ActionNotSupported
    } else {
        ErrorCode::ActionFailed
    };
    AdapterError::new(code, cause.message())
        .with_details(json!({
            "kind": "scroll_into_view",
            "cause": cause.name(),
            "rungs_tried": tried,
            "physical_delivery_started": false,
        }))
        .with_disposition(DeliverySemantics::not_delivered())
}

enum Outcome {
    Realised,
    Stopped(Cause),
}

fn watch<P: ScrollPort, W: Waiter>(port: &mut P, waiter: &mut W) -> Result<bool, AdapterError> {
    realised(waiter, OBSERVE_WINDOW, POLL_INTERVAL, || port.observe())
}

fn scroll_to_rung<P: ScrollPort, W: Waiter>(
    port: &mut P,
    waiter: &mut W,
    delivered: &mut bool,
) -> Result<Outcome, AdapterError> {
    if !port.scroll_to()? {
        return Ok(Outcome::Stopped(Cause::NoRoute));
    }
    *delivered = true;
    Ok(if watch(port, waiter)? {
        Outcome::Realised
    } else {
        Outcome::Stopped(Cause::NotRealised)
    })
}

fn bar_rung<P: ScrollPort, W: Waiter>(
    port: &mut P,
    waiter: &mut W,
    delivered: &mut bool,
) -> Result<Outcome, AdapterError> {
    let first = port.geometry()?;
    let axes = if usable(first.target).is_some() {
        vec![axis_of(first.target, first.container.or(first.frame))]
    } else {
        vec![Axis::Vertical, Axis::Horizontal]
    };
    let mut stopped = Cause::NoBar;
    let mut chosen = None;
    for axis in axes {
        match port.find_bar(axis)? {
            BarFound::Found { extents } if port.range()?.is_some() => {
                chosen = Some((axis, extents));
                break;
            }
            BarFound::Found { .. } | BarFound::Missing { container: true } => {
                stopped = Cause::NoBar;
            }
            BarFound::Missing { container: false } => stopped = Cause::NoContainer,
        }
    }
    let Some((axis, extents)) = chosen else {
        return Ok(Outcome::Stopped(stopped));
    };
    for _ in 0..MAX_WRITES {
        let geometry = port.geometry()?;
        let Some(range) = port.range()? else {
            return Ok(Outcome::Stopped(Cause::NoBar));
        };
        let viewport = [geometry.container, extents, geometry.frame]
            .into_iter()
            .find_map(usable);
        let aim = viewport
            .and_then(|viewport| aim_for(geometry.target, geometry.neighbour, axis, viewport));
        let (Some(viewport), Some(aim)) = (viewport, aim) else {
            return Ok(Outcome::Stopped(Cause::CannotAim));
        };
        match next_value(range, viewport, axis, aim) {
            Step::AtLimit => return Ok(Outcome::Stopped(Cause::AtLimit)),
            Step::Write(value) => {
                port.write(value)?;
                *delivered = true;
            }
        }
        if watch(port, waiter)? {
            return Ok(Outcome::Realised);
        }
    }
    Ok(Outcome::Stopped(Cause::NotRealised))
}

fn usable(rect: Option<Extents>) -> Option<Extents> {
    rect.filter(|rect| {
        rect.width > 0 && rect.height > 0 && rect.x != i32::MIN && rect.y != i32::MIN
    })
}

/// Brings the target on screen by the rungs its toolkit answers to, judging
/// each by looking at the target again and never by what a call returned. An
/// element already on screen, or one whose position a pointer could not use,
/// is left alone.
pub(crate) fn drive<P: ScrollPort, W: Waiter>(
    port: &mut P,
    waiter: &mut W,
) -> Result<bool, AdapterError> {
    let view = port.view()?;
    if view.window_minimized {
        return Err(refusal(FocusCause::WindowHidden));
    }
    if view.offscreen != Some(true) {
        if view.hidden {
            return Err(failure(Cause::TargetHidden, &[]));
        }
        if !view.bounds_provable {
            return Err(failure(Cause::BoundsNotProvable, &[]));
        }
        if view.offscreen.is_none() {
            return Err(failure(Cause::VisibilityUnknown, &[]));
        }
        return Ok(false);
    }
    let mut delivered = false;
    let toolkit = port.toolkit();
    let (mut tried, mut cause) = (Vec::new(), Cause::NoRoute);
    for rung in rungs_for(&toolkit) {
        tried.push(rung.name());
        let outcome = match rung {
            Rung::ScrollTo => scroll_to_rung(port, waiter, &mut delivered),
            Rung::BarValue => bar_rung(port, waiter, &mut delivered),
        }
        .map_err(|error| {
            if delivered {
                error.with_disposition(DeliverySemantics::uncertain())
            } else {
                error
            }
        })?;
        match outcome {
            Outcome::Realised => return Ok(delivered),
            Outcome::Stopped(stopped) => cause = cause.max(stopped),
        }
    }
    let error = failure(cause, &tried);
    Err(if delivered {
        error.with_disposition(DeliverySemantics::delivered_unverified())
    } else {
        error
    })
}

/// What the pointer path makes of a scroll it ran before its first pointer
/// event. A failed scroll leaves the gesture undelivered whatever the scroll
/// itself delivered. A toolkit that recycles the target's row while the list
/// moves leaves a stale handle for an element that lives on, so a handle that
/// went stale after the scroll was delivered ends the scroll and the caller
/// resolves its ref again to look.
pub(crate) fn before_pointer(scroll: Result<bool, AdapterError>) -> Result<(), AdapterError> {
    match scroll {
        Ok(_) => Ok(()),
        Err(error)
            if error.code == ErrorCode::StaleRef
                && error.disposition == DeliverySemantics::uncertain() =>
        {
            Ok(())
        }
        Err(error) => Err(error.with_disposition(DeliverySemantics::not_delivered())),
    }
}

pub(crate) fn scroll_into_view(
    bus: &SharedBus,
    handle: &NativeHandle,
    lease: &InteractionLease,
) -> Result<bool, AdapterError> {
    let deadline = lease.deadline();
    let element = atspi_element(handle)?;
    drive(
        &mut BusPort::new(bus, handle, element, deadline),
        &mut Clock::new(deadline),
    )
}

#[cfg(test)]
#[path = "scroll_into_view_tests.rs"]
mod tests;
