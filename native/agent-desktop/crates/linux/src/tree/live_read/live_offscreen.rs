use std::collections::HashMap;
use std::sync::{Mutex, OnceLock, PoisonError};

use agent_desktop_core::Deadline;
use futures_util::future::join4;
use zbus::Connection;

use crate::system::display::display_server::{DisplayServer, session_server};
use crate::system::process::toolkit_id::ToolkitId;
use crate::system::x11::stacking::frame_window_state;
use crate::system::x11::window::frame_window::FrameWindow;
use crate::system::x11::window::window_x11_state::WindowX11State;
use crate::system::x11::{self, DisplayReader, FrameFacts, MonitorReader, MonitorSource};
use crate::system::{ACCESSIBLE_INTERFACE, REGISTRY_ROOT_PATH, SharedBus, shell, within};
use crate::tree::placement::Placement;
use crate::tree::placement::offscreen::{OffscreenInput, offscreen};
use crate::tree::properties::liveness::Liveness;
use crate::tree::properties::node_read::{call, get_one, string_value};
use crate::tree::properties::toolkit_trust::{read_toolkit, reports_global_position};
use crate::tree::surfaces::twin_frames::read_twins;
use crate::tree::surfaces::window_extents::read_window_extents;
use crate::tree::surfaces::window_tie::WindowTie;
use crate::tree::vocabulary::state_bits::{ICONIFIED, StateBits};
use crate::tree::{AtspiElement, Extents};

fn known_toolkits() -> &'static Mutex<HashMap<String, ToolkitId>> {
    static KNOWN: OnceLock<Mutex<HashMap<String, ToolkitId>>> = OnceLock::new();
    KNOWN.get_or_init(Mutex::default)
}

/// The toolkit of the application `element` belongs to. An application keeps
/// its toolkit for as long as its unique bus name lives, so a name that was
/// read is remembered and costs no call afterwards; a read that gave no
/// toolkit name is not remembered.
pub(crate) fn toolkit_of(bus: &SharedBus, element: &AtspiElement, deadline: Deadline) -> ToolkitId {
    let remembered = known_toolkits()
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .get(element.bus_name())
        .cloned();
    if let Some(known) = remembered {
        return known;
    }
    let Ok(connection) = bus.get(deadline) else {
        return ToolkitId::default();
    };
    let root = AtspiElement::new(element.bus_name(), REGISTRY_ROOT_PATH, element.pid());
    let read = within(deadline, async {
        read_toolkit(connection.inner(), &root).await
    });
    let read = read.unwrap_or_default();
    if read.name.is_some() {
        known_toolkits()
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(element.bus_name().to_owned(), read.clone());
    }
    read
}

/// Whether the application of `element` reports screen positions that are
/// global.
pub(crate) fn global_position(bus: &SharedBus, element: &AtspiElement, deadline: Deadline) -> bool {
    reports_global_position(&toolkit_of(bus, element, deadline))
}

/// The frame's iconified bit, title and screen extents. A missing or unreadable
/// state leaves iconification unknown; unreadable title
/// and extents remain absent rather than becoming empty values.
pub(crate) struct FrameRead {
    pub(crate) iconified: Option<bool>,
    role: Option<u32>,
    pub(crate) title: Option<String>,
    pub(crate) screen: Option<Extents>,
}

async fn read_frame(connection: &Connection, frame: &AtspiElement) -> FrameRead {
    let (state, title, extents, role) = join4(
        call(connection, frame, ACCESSIBLE_INTERFACE, "GetState", &()),
        get_one(connection, frame, "Name", string_value, Liveness::Alive),
        shell::light::extents_of(connection, frame),
        call(connection, frame, ACCESSIBLE_INTERFACE, "GetRole", &()),
    )
    .await;
    let words = state
        .ok()
        .and_then(|reply| reply.body().deserialize::<Vec<u32>>().ok())
        .filter(|words| !words.is_empty());
    FrameRead {
        role: role
            .ok()
            .and_then(|reply| reply.body().deserialize::<u32>().ok()),
        iconified: words.map(|words| StateBits::new(&words).has(ICONIFIED)),
        title: title.ok().and_then(|field| field.present().cloned()),
        screen: extents,
    }
}

fn wholly_outside(placement: &Placement) -> bool {
    offscreen(OffscreenInput {
        node: placement.node,
        frame: placement.frame,
        container: placement.container,
        visible: true,
        showing: true,
        sentinel: false,
        minimized: Some(false),
    }) == Some(true)
}

/// Reads where `element` sits in its window once: its own rectangle, the
/// frame's and the scroll container's in window coordinates, whether the frame
/// is iconified, the toolkit, and what the display server says about the
/// window, and the displays the screen rectangle is judged against. Every part
/// that could not be read stays absent; nothing is guessed.
pub(crate) fn placement(bus: &SharedBus, element: &AtspiElement, deadline: Deadline) -> Placement {
    if shell::is_shell_element(element) {
        return shell::live_state::placement(bus, element, deadline);
    }
    let pending = x11::start(|| MonitorReader.read());
    let mut placed = place(bus, element, deadline);
    placed.displays = match pending.finish(deadline) {
        Some(Ok(monitors)) => Some(monitors.into_iter().map(|monitor| monitor.bounds).collect()),
        _ => None,
    };
    placed
}

fn place(bus: &SharedBus, element: &AtspiElement, deadline: Deadline) -> Placement {
    let toolkit = toolkit_of(bus, element, deadline);
    let mut placed = Placement {
        node: read_window_extents(bus, element, deadline),
        container: element
            .scroll_container()
            .and_then(|container| read_window_extents(bus, container, deadline)),
        wayland_unplaced: !reports_global_position(&toolkit)
            && session_server() == DisplayServer::Wayland,
        toolkit,
        ..Placement::default()
    };
    let (Some(frame), Ok(connection)) = (element.frame(), bus.get(deadline)) else {
        return placed;
    };
    placed.frame = read_window_extents(bus, frame, deadline);
    let read = within(deadline, async {
        Ok(read_frame(connection.inner(), frame).await)
    });
    let Ok(read) = read else {
        return placed;
    };
    placed.frame_iconified = read.iconified;
    if element.is_menu_target()
        && matches!(
            read.role,
            Some(
                crate::tree::vocabulary::role_numbers::MENU
                    | crate::tree::vocabulary::role_numbers::TOGGLE_BUTTON
            )
        )
        && crate::tree::properties::toolkit_trust::kind(&placed.toolkit)
            == crate::tree::properties::toolkit_trust::ToolkitKind::Gtk3
    {
        let popup = within(deadline, async {
            Ok(read_frame(connection.inner(), element).await)
        })
        .ok()
        .and_then(|read| read.screen)
        .zip(placed.node)
        .and_then(|(screen, window)| {
            DisplayReader::popup_containing(element.pid(), screen, window, deadline)
        });
        apply_popup(&mut placed, popup);
        return placed;
    }
    let global = reports_global_position(&placed.toolkit);
    let skipped = placed.frame_iconified == Some(true) || (wholly_outside(&placed) && global);
    let facts = || {
        read.title.clone().map(|title| FrameFacts {
            size_identity: title.is_empty()
                && crate::system::window::frame_identity::permits_on_bus(
                    bus,
                    frame,
                    &placed.toolkit,
                    read.screen,
                    deadline,
                ),
            pid: frame.pid(),
            title,
            extents: read.screen,
            global_position: global,
        })
    };
    let twins = |title: &str| {
        within(deadline, async {
            Ok(read_twins(connection.inner(), frame, title).await)
        })
        .ok()
        .flatten()
    };
    let window = std::cell::Cell::new(FrameWindow::Unknown);
    let (popup_origin, x11) = select_frame_origin(
        crate::tree::placement::popup_frame::uses_popup_origin(
            read.role,
            &placed.toolkit,
            element.is_menu_target(),
        ),
        placed.frame,
        |size| DisplayReader::popup_origin(frame.pid(), size, deadline),
        || {
            if skipped {
                return None;
            }
            let facts = facts()?;
            let found =
                frame_window_state(&DisplayReader, deadline, &facts, || twins(&facts.title));
            window.set(found);
            match found {
                FrameWindow::Client(state) => Some(state),
                FrameWindow::Tied { .. } | FrameWindow::Unknown => None,
            }
        },
    );
    placed.tie = match window.get() {
        FrameWindow::Tied { hidden } if !global => Some(WindowTie { hidden }),
        FrameWindow::Tied { .. } | FrameWindow::Client(_) | FrameWindow::Unknown => None,
    };
    placed.popup_origin = popup_origin;
    placed.x11 = x11;
    placed
}

/// Chooses the origin used to place one frame's nodes. A GTK4 menu is its own
/// override-redirect window: it can only use the uniquely matched popup origin
/// and never falls back to the owning managed window. Other frames keep the
/// ordinary X11 client state.
pub(crate) fn select_frame_origin(
    popup_frame: bool,
    frame: Option<Extents>,
    popup: impl FnOnce((i32, i32)) -> Option<(i32, i32)>,
    managed: impl FnOnce() -> Option<WindowX11State>,
) -> (Option<(i32, i32)>, Option<WindowX11State>) {
    if popup_frame {
        let origin = frame.and_then(|frame| {
            popup((frame.width, frame.height)).and_then(|origin| {
                crate::tree::placement::frame_geometry::popup_origin(origin, frame)
            })
        });
        (origin, None)
    } else {
        (None, managed())
    }
}

fn apply_popup(placed: &mut Placement, popup: Option<crate::system::x11::PopupWindow>) {
    placed.frame = popup.map(|popup| Extents {
        x: 0,
        y: 0,
        ..popup.bounds
    });
    placed.x11 = popup.map(|popup| WindowX11State {
        client_id: popup.id,
        hidden: false,
        client_origin: (popup.bounds.x, popup.bounds.y),
        shadow: (0, 0, 0, 0),
    });
}

#[cfg(test)]
#[path = "popup_placement_tests.rs"]
mod popup_tests;
