use x11rb::connection::Connection;
use x11rb::errors::ReplyError;
use x11rb::protocol::xproto::{AtomEnum, ConnectionExt, Window};
use x11rb::rust_connection::RustConnection;

use super::drawable_info::DrawableInfo;
use super::grab_error::{GrabError, unreadable};
use super::map_state::MapState;
use crate::system::x11::MonitorFault;
use crate::system::x11::snapshot::decode_frame_extents;
use crate::system::x11::window::frame_extents::FrameExtents;
use crate::tree::Extents;

pub(crate) fn root_of(connection: &RustConnection, screen: usize) -> Result<Window, GrabError> {
    connection
        .setup()
        .roots
        .get(screen)
        .map(|screen| screen.root)
        .ok_or(GrabError::Fault(MonitorFault::Unreadable))
}

pub(crate) fn parent_of(parent: Window, root: Window) -> Option<u32> {
    (parent != x11rb::NONE && parent != root).then_some(parent)
}

pub(crate) fn reply_error(
    connection: &RustConnection,
    drawable: Window,
    error: ReplyError,
) -> GrabError {
    match error {
        ReplyError::X11Error(wire) => {
            GrabError::from_error_kind(wire.error_kind, || map_state_of(connection, drawable))
        }
        ReplyError::ConnectionError(_) => GrabError::Fault(MonitorFault::Unreadable),
    }
}

fn map_state_of(connection: &RustConnection, drawable: Window) -> MapState {
    connection
        .get_window_attributes(drawable)
        .ok()
        .and_then(|cookie| cookie.reply().ok())
        .map_or(MapState::Unmapped, |attributes| attributes.map_state.into())
}

fn shadow_of(connection: &RustConnection, window: Window) -> Option<FrameExtents> {
    let atom = connection
        .intern_atom(false, b"_GTK_FRAME_EXTENTS")
        .ok()?
        .reply()
        .ok()?
        .atom;
    let reply = connection
        .get_property(false, window, atom, AtomEnum::CARDINAL, 0, 4)
        .ok()?
        .reply()
        .ok()?;
    decode_frame_extents(reply.format, &reply.value)
}

pub(crate) fn describe(
    connection: &RustConnection,
    root: Window,
    window: Window,
) -> Result<DrawableInfo, GrabError> {
    let geometry = connection.get_geometry(window).map_err(unreadable)?;
    let attributes = connection
        .get_window_attributes(window)
        .map_err(unreadable)?;
    let tree = connection.query_tree(window).map_err(unreadable)?;
    let origin = connection
        .translate_coordinates(window, root, 0, 0)
        .map_err(unreadable)?;
    let geometry = geometry
        .reply()
        .map_err(|error| reply_error(connection, window, error))?;
    let attributes = attributes
        .reply()
        .map_err(|error| reply_error(connection, window, error))?;
    let tree = tree
        .reply()
        .map_err(|error| reply_error(connection, window, error))?;
    let origin = origin
        .reply()
        .map_err(|error| reply_error(connection, window, error))?;
    Ok(DrawableInfo {
        rect: Extents {
            x: i32::from(origin.dst_x),
            y: i32::from(origin.dst_y),
            width: i32::from(geometry.width),
            height: i32::from(geometry.height),
        },
        parent: parent_of(tree.parent, root),
        depth: geometry.depth,
        map_state: attributes.map_state.into(),
        override_redirect: attributes.override_redirect,
        shadow: shadow_of(connection, window),
    })
}
