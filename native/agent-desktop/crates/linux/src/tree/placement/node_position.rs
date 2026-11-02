use super::visibility::is_sentinel;
use agent_desktop_core::BoundsSpace;
use agent_desktop_core::{AdapterError, Deadline, ErrorCode};

use super::frame_geometry::{pointer_bounds, popup_origin};
use crate::system::process::toolkit_id::ToolkitId;
use crate::system::window::window_position::{origin_of_client, rect_of_client};
use crate::system::x11::map::ClientMatch;
use crate::system::x11::stacking::stacking_source::StackingSource;
use crate::system::x11::twin_tie::client_among_twins;
use crate::system::x11::{DisplayReader, FrameFacts, X11State};
use crate::system::{REGISTRY_ROOT_PATH, SharedBus, shell, within};
use crate::tree::element::bounded::collect_bounded;
use crate::tree::properties::node_read::read_node_for;
use crate::tree::properties::read_purpose::ReadPurpose;
use crate::tree::properties::toolkit_trust::{read_toolkit, reports_global_position};
use crate::tree::surfaces::twin_frames::read_twins;
use crate::tree::surfaces::window_extents::read_window_extents_async;
use crate::tree::{AtspiElement, Extents, Field, ObservedRead, Walk, WalkedNode};

const IN_FLIGHT: usize = 64;

fn invalidate_position(read: &mut ObservedRead) {
    read.node.extents = Field::Failed("Geometry placement was not read".to_owned());
    read.evidence_bounds = None;
}

fn for_each_read(node: &mut WalkedNode<ObservedRead>, visit: &mut impl FnMut(&mut ObservedRead)) {
    visit(&mut node.payload);
    for child in &mut node.children {
        for_each_read(child, visit);
    }
}

/// Where the nodes of one frame are placed: the origin of its window
/// coordinates in the pointer frame and, when an X11 client draws the frame,
/// the rectangle that client draws it at.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct FramePlace {
    origin: (i32, i32),
    drawn: Option<Extents>,
}

/// The rectangle the frame's X11 client draws `element` at, when `element` is
/// that frame. A toolkit that reports window coordinates can give a rectangle
/// of the frame that lags behind the window, and a pointer lands where the
/// client is, so the client's rectangle replaces it. Every node below the frame
/// keeps its own.
fn drawn_frame(element: &AtspiElement, place: Option<FramePlace>) -> Option<Extents> {
    place?.drawn.filter(|_| element.frame() == Some(element))
}

/// Rewrites the extents of every placed node to the rectangle a pointer is
/// aimed in: the window-coordinate rectangle moved to the client origin, and
/// for the frame itself the rectangle its client draws. `windows` holds, in
/// walk order, the window-coordinate rectangle of each placed node. A node
/// whose position cannot be proved ends without extents, because the
/// toolkit's own position is `[0, 0]` and is never a position.
fn apply(
    root: &mut WalkedNode<ObservedRead>,
    toolkit: &ToolkitId,
    place: Option<FramePlace>,
    windows: &[Option<Extents>],
) {
    let mut next = windows.iter();
    for_each_read(root, &mut |read| {
        if read.node.extents.present().copied().is_none_or(is_sentinel) {
            return;
        }
        let window = next.next().copied().flatten();
        place_read_bounds(read, toolkit, place, window);
    });
}

/// Places one read for evidence: the pointer rectangle when the frame's place
/// is known, otherwise the toolkit's own window rectangle. A Wayland session
/// reports no global position, so the window rectangle is the only stable
/// evidence and is tagged with its frame; a node with neither keeps none.
fn place_read_bounds(
    read: &mut ObservedRead,
    toolkit: &ToolkitId,
    place: Option<FramePlace>,
    window: Option<Extents>,
) {
    let Field::Present(screen) = &read.node.extents else {
        read.evidence_bounds = None;
        return;
    };
    let screen = *screen;
    read.evidence_bounds = window
        .filter(|window| !is_sentinel(*window))
        .map(|window| (window, BoundsSpace::Window));
    read.node.extents = drawn_frame(&read.node.element, place)
        .or_else(|| {
            place.zip(window).and_then(|(place, window)| {
                pointer_bounds(toolkit, screen, window, Some(place.origin))
            })
        })
        .map_or_else(
            || Field::Failed("Screen position could not be established".to_owned()),
            Field::Present,
        );
}

fn placed_elements(root: &mut WalkedNode<ObservedRead>) -> Vec<AtspiElement> {
    let mut elements = Vec::new();
    for_each_read(root, &mut |read| {
        if read
            .node
            .extents
            .present()
            .copied()
            .is_some_and(|extents| !is_sentinel(extents))
        {
            elements.push(read.node.element.clone());
        }
    });
    elements
}

async fn window_rectangles(
    connection: &zbus::Connection,
    elements: &[AtspiElement],
) -> Result<Vec<Option<Extents>>, AdapterError> {
    collect_bounded(
        IN_FLIGHT,
        elements
            .iter()
            .map(|element| read_window_extents_async(connection, element)),
    )
    .await
    .into_iter()
    .collect()
}

async fn frame_facts(
    connection: &zbus::Connection,
    frame: &AtspiElement,
) -> Result<Option<crate::tree::RawNode>, AdapterError> {
    let node = match read_node_for(connection, frame, ReadPurpose::Frame)
        .await
        .map(|(node, _)| node)
    {
        Ok(node) => node,
        Err(error)
            if matches!(
                error.code,
                ErrorCode::AppNotFound | ErrorCode::ElementNotFound
            ) =>
        {
            return Ok(None);
        }
        Err(error) => return Err(error),
    };
    Ok(Some(node))
}

/// The place of the frame's nodes: the origin and the drawn rectangle of its
/// X11 client, or the origin of its popup. The title is read on the bus; the
/// display-server read then runs here, outside any polled future, under the
/// caller's deadline.
fn place_of(
    bus: &SharedBus,
    connection: &zbus::Connection,
    element: &AtspiElement,
    toolkit: &ToolkitId,
    deadline: Deadline,
) -> Result<Option<FramePlace>, AdapterError> {
    let Some(frame) = element.frame() else {
        return Ok(None);
    };
    let Some(node) = geometry_or_unknown(within(deadline, frame_facts(connection, frame)))? else {
        return Ok(None);
    };
    let title = node.properties.name.present().cloned().unwrap_or_default();
    let role = node.traits.role.present().copied();
    let screen = node.extents.present().copied();
    if super::popup_frame::uses_popup_origin(role, toolkit, element.is_menu_target()) {
        let Some(window) = geometry_or_unknown(within(
            deadline,
            read_window_extents_async(connection, frame),
        ))?
        .or(screen) else {
            return Ok(None);
        };
        return Ok(DisplayReader::popup_origin(
            frame.pid(),
            (window.width, window.height),
            deadline,
        )
        .and_then(|origin| popup_origin(origin, window))
        .map(|origin| FramePlace {
            origin,
            drawn: None,
        }));
    }
    let facts = FrameFacts {
        size_identity: title.is_empty()
            && crate::system::window::frame_identity::permits_on_bus(
                bus, frame, toolkit, screen, deadline,
            ),
        pid: frame.pid(),
        title,
        extents: screen,
        global_position: false,
    };
    let X11State::Ready { active, clients } = DisplayReader.clients_within(deadline) else {
        return Ok(None);
    };
    let found = client_among_twins(&facts, &clients, active, || {
        within(deadline, async {
            Ok(read_twins(connection, frame, &facts.title).await)
        })
        .ok()
        .flatten()
    });
    Ok(match found {
        ClientMatch::One(id) => origin_of_client(&clients, id).map(|origin| FramePlace {
            origin,
            drawn: rect_of_client(&clients, id),
        }),
        ClientMatch::Several(_) | ClientMatch::NoClient => None,
    })
}

/// Puts the node rectangles of a finished walk where a pointer can be aimed
/// when the application's toolkit reports no global position. A toolkit with
/// global positions is left as read. Anything else gets its window-coordinate
/// rectangles moved to the window's X11 client origin, the window itself gets
/// the rectangle its client draws, and the rectangles it cannot place are
/// dropped.
pub(crate) fn place_nodes(
    bus: &SharedBus,
    walk: &mut Walk<ObservedRead>,
    deadline: Deadline,
) -> Result<(), AdapterError> {
    let element = walk.root.payload.node.element.clone();
    if shell::is_shell_element(&element) {
        return Ok(());
    }
    let connection = match bus.get(deadline) {
        Ok(connection) => connection,
        Err(error) if error.code == ErrorCode::Timeout => {
            for_each_read(&mut walk.root, &mut invalidate_position);
            return Ok(());
        }
        Err(error) => return Err(error),
    };
    let app_root = AtspiElement::new(element.bus_name(), REGISTRY_ROOT_PATH, element.pid());
    let toolkit = geometry_or_unknown(within(
        deadline,
        read_toolkit(connection.inner(), &app_root),
    ))?;
    if reports_global_position(&toolkit) {
        return Ok(());
    }
    let place = place_of(bus, connection.inner(), &element, &toolkit, deadline)?;
    let elements = placed_elements(&mut walk.root);
    let windows = geometry_or_unknown(within(
        deadline,
        window_rectangles(connection.inner(), &elements),
    ))?;
    apply(&mut walk.root, &toolkit, place, &windows);
    Ok(())
}

/// A spent observation budget leaves geometry unknown; transport loss is an error.
fn geometry_or_unknown<T: Default>(read: Result<T, AdapterError>) -> Result<T, AdapterError> {
    match read {
        Err(error) if error.code == ErrorCode::Timeout => Ok(T::default()),
        other => other,
    }
}

#[cfg(test)]
#[path = "node_position_tests.rs"]
mod tests;

/// Places one node read without walking its window: the same rule the walk
/// applies, used where only one node's evidence is wanted. A toolkit with
/// global positions is left as read.
pub(crate) fn place_single(
    bus: &SharedBus,
    read: &mut ObservedRead,
    deadline: Deadline,
) -> Result<(), AdapterError> {
    let element = read.node.element.clone();
    let connection = match bus.get(deadline) {
        Ok(connection) => connection,
        Err(error) if error.code == ErrorCode::Timeout => {
            invalidate_position(read);
            return Ok(());
        }
        Err(error) => return Err(error),
    };
    let app_root = AtspiElement::new(element.bus_name(), REGISTRY_ROOT_PATH, element.pid());
    let toolkit = geometry_or_unknown(within(
        deadline,
        read_toolkit(connection.inner(), &app_root),
    ))?;
    if reports_global_position(&toolkit) {
        return Ok(());
    }
    let place = place_of(bus, connection.inner(), &element, &toolkit, deadline)?;
    let window = geometry_or_unknown(within(
        deadline,
        read_window_extents_async(connection.inner(), &element),
    ))?;
    place_read_bounds(read, &toolkit, place, window);
    Ok(())
}
