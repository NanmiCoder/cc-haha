//! A session-scoped X11 overlay retained by the server between adapter calls.
use x11rb::connection::Connection;
use x11rb::protocol::shape::{ConnectionExt as _, SK};
use x11rb::protocol::xproto::*;

use agent_desktop_core::{AdapterError, CursorOverlayControl, Deadline, FileLock};

#[path = "cursor_overlay_capture.rs"]
mod capture;
#[path = "cursor_overlay_draw.rs"]
mod draw;
#[path = "cursor_overlay_visual.rs"]
mod visual;

pub(crate) use capture::with_hidden;

fn error(detail: impl std::fmt::Display) -> AdapterError {
    AdapterError::internal("The X11 cursor overlay could not be updated")
        .with_platform_detail(detail.to_string())
}

fn connect(display: &str) -> Result<(x11rb::rust_connection::RustConnection, usize), AdapterError> {
    let (connection, root) = crate::system::x11::control_display::open(display)
        .ok_or_else(|| error("The display did not answer the cursor connection"))?;
    let index = connection
        .setup()
        .roots
        .iter()
        .position(|screen| screen.root == root)
        .ok_or_else(|| error("The cursor display has no root screen"))?;
    Ok((connection, index))
}

pub(crate) fn update(control: &CursorOverlayControl) -> Result<(), AdapterError> {
    control.validate()?;
    let deadline = Deadline::after(4_000)?;
    let display = match crate::system::display::display_server::require(deadline)? {
        crate::system::display::route::Route::X11(display) => display,
        crate::system::display::route::Route::Wayland => {
            return Err(AdapterError::not_supported("cursor overlay on Wayland")
                .with_details(serde_json::json!({"rendered": false, "cause": "wayland_session"})));
        }
    };
    let root = agent_desktop_core::session::agent_desktop_dir().map_err(error)?;
    let _lock = FileLock::acquire(
        &root.join(".x11-cursor.lock"),
        deadline,
        "cursor overlay update",
    )?;
    let control = control.clone();
    crate::system::x11::start(move || apply(&display, &control))
        .finish(deadline)
        .ok_or_else(|| AdapterError::timeout("The X11 cursor overlay did not answer in time"))?
}

#[cfg(test)]
#[path = "cursor_overlay_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "cursor_overlay_cli_tests.rs"]
mod cli_tests;

const OWNER: &[u8] = b"_AGENT_DESKTOP_CURSOR_OWNER";

pub(in crate::system) fn is_overlay(
    connection: &x11rb::rust_connection::RustConnection,
    window: Window,
    attributes: &GetWindowAttributesReply,
    geometry: &GetGeometryReply,
) -> Result<bool, AdapterError> {
    if !attributes.override_redirect || geometry.depth != 32 {
        return Ok(false);
    }
    let atom = connection
        .intern_atom(false, OWNER)
        .map_err(error)?
        .reply()
        .map_err(error)?
        .atom;
    let owner = connection
        .get_property(false, window, atom, AtomEnum::STRING, 0, 1024)
        .map_err(error)?
        .reply()
        .map_err(error)?;
    if owner.format != 8
        || owner.bytes_after != 0
        || !serde_json::from_slice::<(String, Option<String>)>(&owner.value)
            .is_ok_and(|(session, _)| !session.is_empty())
    {
        return Ok(false);
    }
    Ok(connection
        .shape_get_rectangles(window, SK::INPUT)
        .map_err(error)?
        .reply()
        .map_err(error)?
        .rectangles
        .is_empty())
}

fn apply(display: &str, control: &CursorOverlayControl) -> Result<(), AdapterError> {
    let (connection, index) = connect(display)?;
    let root = connection.setup().roots[index].root;
    let atom = connection
        .intern_atom(false, OWNER)
        .map_err(error)?
        .reply()
        .map_err(error)?
        .atom;
    let mut found = false;
    for window in connection
        .query_tree(root)
        .map_err(error)?
        .reply()
        .map_err(error)?
        .children
    {
        let property = connection
            .get_property(false, window, atom, AtomEnum::STRING, 0, 1024)
            .map_err(error)?
            .reply();
        let Ok(property) = property else { continue };
        let Ok((session, agent)) =
            serde_json::from_slice::<(String, Option<String>)>(&property.value)
        else {
            continue;
        };
        if session != control.session_id()
            || (!(control.is_disable() || (control.is_transient() && control.agent_id().is_none()))
                && agent.as_deref() != control.agent_id())
        {
            continue;
        }
        let attrs = connection
            .get_window_attributes(window)
            .map_err(error)?
            .reply()
            .map_err(error)?;
        let geometry = connection
            .get_geometry(window)
            .map_err(error)?
            .reply()
            .map_err(error)?;
        if !attrs.override_redirect || geometry.depth != 32 {
            return Err(error(
                "The cursor ownership property names an incompatible window",
            ));
        }
        found = true;
        if control.is_disable() {
            connection
                .kill_client(window)
                .map_err(error)?
                .check()
                .map_err(error)?;
        } else {
            let (paint, _) = connect(display)?;
            let mut overlay = draw::Overlay {
                connection: paint,
                window,
                point: agent_desktop_core::Point {
                    x: f64::from(geometry.x),
                    y: f64::from(geometry.y),
                },
            };
            overlay.update(control)?;
        }
    }
    if !found && !control.is_disable() && !control.is_transient() {
        let mut overlay = draw::Overlay::open(display)?;
        overlay.update(control)?;
        overlay.retain(
            &serde_json::to_vec(&(control.session_id(), control.agent_id())).map_err(error)?,
        )?;
    }
    Ok(())
}
