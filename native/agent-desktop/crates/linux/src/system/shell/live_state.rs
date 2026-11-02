use agent_desktop_core::Deadline;

use super::hit::display_extents;
use super::light::extents_of;
use crate::system::x11::window::window_x11_state::WindowX11State;
use crate::system::{SharedBus, within};
use crate::tree::placement::Placement;
use crate::tree::placement::display_bounds::off_every_display;
use crate::tree::{AtspiElement, Extents};

fn union(displays: &[Extents]) -> Option<Extents> {
    let left = displays.iter().map(|display| display.x).min()?;
    let top = displays.iter().map(|display| display.y).min()?;
    let right = displays
        .iter()
        .map(|display| i64::from(display.x) + i64::from(display.width))
        .max()?;
    let bottom = displays
        .iter()
        .map(|display| i64::from(display.y) + i64::from(display.height))
        .max()?;
    Some(Extents {
        x: left,
        y: top,
        width: i32::try_from(right - i64::from(left)).ok()?,
        height: i32::try_from(bottom - i64::from(top)).ok()?,
    })
}

/// The placement of a shell node. The shell has no client window to lie
/// inside, and its window and screen coordinates are equal, so the frame is
/// the union of the displays and the client origin is zero. A node cannot be
/// shown when its extents are the sentinel or lie wholly outside every
/// display; that is the only way it is marked offscreen.
pub(crate) fn project(extents: Option<Extents>, displays: Option<&[Extents]>) -> Placement {
    let sentinel = extents.is_some_and(|extents| extents.x == i32::MIN || extents.y == i32::MIN);
    let cannot_show = sentinel || off_every_display(extents, displays);
    Placement {
        node: extents,
        frame: displays.and_then(union),
        displays: displays
            .filter(|list| !list.is_empty())
            .map(<[Extents]>::to_vec),
        x11: Some(WindowX11State {
            client_id: 0,
            hidden: cannot_show,
            client_origin: (0, 0),
            shadow: (0, 0, 0, 0),
        }),
        ..Placement::default()
    }
}

pub(crate) fn placement(bus: &SharedBus, element: &AtspiElement, deadline: Deadline) -> Placement {
    let Ok(connection) = bus.get(deadline) else {
        return Placement::default();
    };
    let extents = within(deadline, async {
        Ok(extents_of(connection.inner(), element).await)
    })
    .ok()
    .flatten();
    project(extents, display_extents(deadline).as_deref())
}

#[cfg(test)]
#[path = "live_state_tests.rs"]
mod tests;
