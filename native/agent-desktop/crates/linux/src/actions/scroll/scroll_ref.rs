use agent_desktop_core::{
    AdapterError, BoundsSpace, InteractionLease, NativeHandle, Rect, RefEntry, RefGeometry,
};

use super::scroll_bus::BusPort;
use super::scroll_find_bar::Orientation;
use super::scroll_into_view::{BarFound, Geometry, ScrollPort};
use super::scroll_plan::{Axis, BarRange};
use crate::system::SharedBus;
use crate::tree::{AtspiElement, atspi_element};

struct Witness {
    bar: AtspiElement,
    geometry: Geometry,
    range: BarRange,
    bar_bounds: crate::tree::Extents,
    orientation: Orientation,
}

impl Witness {
    fn read(port: &mut BusPort<'_>) -> Option<Self> {
        let geometry = port.geometry().ok()?;
        let BarFound::Found {
            extents: Some(bar_bounds),
        } = port.find_bar(Axis::Vertical).ok()?
        else {
            return None;
        };
        if !uuid_context(port.bar()?.path()) {
            return None;
        }
        Some(Self {
            range: port.range().ok()??,
            bar: port.bar()?.clone(),
            geometry,
            bar_bounds,
            orientation: port.bar_orientation().ok()?,
        })
    }
}

/// GTK4 gives each realized AT-SPI context a random UUID and clears it on
/// unrealize (gtk/a11y/gtkatspicontext.c, gtk_at_spi_context_realize/unrealize).
/// A replacement context therefore cannot inherit this retained object path.
fn uuid_context(path: &str) -> bool {
    let bytes = path.rsplit('/').next().unwrap_or("").as_bytes();
    bytes.len() == 36
        && bytes[14] == b'4'
        && matches!(bytes[19], b'8' | b'9' | b'a' | b'b')
        && bytes.iter().enumerate().all(|(index, byte)| {
            if matches!(index, 8 | 13 | 18 | 23) {
                *byte == b'_'
            } else {
                byte.is_ascii_hexdigit()
            }
        })
}

fn usable(witness: &Witness) -> bool {
    [
        witness.geometry.target,
        witness.geometry.container,
        witness.geometry.frame,
        Some(witness.bar_bounds),
    ]
    .into_iter()
    .all(|rect| {
        rect.is_some_and(|rect| {
            rect.width > 0 && rect.height > 0 && rect.x != i32::MIN && rect.y != i32::MIN
        })
    }) && witness.range.current >= witness.range.min
        && witness.range.current <= witness.range.max
}

fn translated(entry: &RefEntry, before: &Witness, after: &Witness) -> Option<RefGeometry> {
    let old = entry.geometry.bounds?;
    let first = Rect::from(before.geometry.target?);
    let last = Rect::from(after.geometry.target?);
    let delta = after.range.current - before.range.current;
    if entry.geometry.bounds_space != Some(BoundsSpace::Window)
        || !usable(before)
        || !usable(after)
        || old != first
        || old.width <= 0.0
        || old.height <= 0.0
        || before.bar != after.bar
        || before.orientation != Orientation::Vertical
        || after.orientation != Orientation::Vertical
        || before.bar_bounds != after.bar_bounds
        || before.geometry.container.is_none()
        || before.geometry.frame.is_none()
        || before.geometry.container != after.geometry.container
        || before.geometry.frame != after.geometry.frame
        || before.range.min != after.range.min
        || before.range.max != after.range.max
        || !delta.is_finite()
        || delta.abs() < 0.5
        || first.x != last.x
        || first.width != last.width
        || first.height != last.height
        || (first.y - delta - last.y).abs() >= 1.0
    {
        return None;
    }
    let bounds = Rect {
        y: first.y - delta,
        ..old
    };
    Some(RefGeometry {
        bounds: Some(bounds),
        bounds_hash: bounds.bounds_hash(),
        bounds_space: Some(BoundsSpace::Window),
    })
}

fn eligible(
    entry: &RefEntry,
    element: &AtspiElement,
    toolkit: &crate::system::process::toolkit_id::ToolkitId,
) -> bool {
    entry.identity.role == "incrementor"
        && entry.identity.retained_object.as_deref() == Some(element.object_identity().as_str())
        && uuid_context(element.path())
        && element
            .scroll_container()
            .is_some_and(|node| uuid_context(node.path()))
        && element
            .frame()
            .is_some_and(|node| uuid_context(node.path()))
        && toolkit
            .name
            .as_deref()
            .is_some_and(|name| name.eq_ignore_ascii_case("gtk"))
        && toolkit
            .version
            .as_deref()
            .and_then(|version| version.split('.').next())
            == Some("4")
}

pub(crate) fn scroll(
    bus: &SharedBus,
    entry: &RefEntry,
    handle: &NativeHandle,
    lease: &InteractionLease,
) -> Result<Option<NativeHandle>, AdapterError> {
    let element = atspi_element(handle)?;
    let mut port = BusPort::new(bus, handle, element, lease.deadline());
    let toolkit = port.toolkit();
    let before = eligible(entry, element, &toolkit)
        .then(|| Witness::read(&mut port))
        .flatten();
    crate::actions::scroll_into_view(bus, handle, lease)?;
    let Some(before) = before else {
        return Ok(None);
    };
    let mut port = BusPort::new(bus, handle, element, lease.deadline());
    let Some(after) = Witness::read(&mut port) else {
        return Ok(None);
    };
    let Some(geometry) = translated(entry, &before, &after) else {
        return Ok(None);
    };
    let mut moved = entry.clone();
    moved.geometry = geometry;
    let Ok(resolved) = crate::tree::resolve_element_strict(bus, &moved, lease.deadline()) else {
        return Ok(None);
    };
    let live = atspi_element(&resolved)?;
    if live != element
        || live.frame() != element.frame()
        || live.scroll_container() != element.scroll_container()
    {
        return Err(AdapterError::stale_ref_because(
            "the scroll target's ancestry changed",
        ));
    }
    Ok(Some(resolved))
}

#[cfg(test)]
#[path = "scroll_ref_tests.rs"]
mod tests;
