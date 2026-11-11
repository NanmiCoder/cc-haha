use agent_desktop_core::Deadline;
use x11rb::connection::{Connection, RequestConnection};
use x11rb::protocol::xproto::{ConnectionExt, ImageFormat, Window};
use x11rb::rust_connection::RustConnection;

use super::drawable::{describe, reply_error, root_of};
use super::drawable_info::DrawableInfo;
use super::grab_error::GrabError;
use super::grab_rect::GrabRect;
use super::visual::format_of;
use crate::system::capture::pixels::{MAX_PIXELS, VisualFormat};
use crate::system::display::display_server::{DisplayServer, session_server};
use crate::system::x11::{MonitorFault, fault_of_connect, start};

const ROOT: u32 = 0;
const WIRE_PIXEL_BYTES: usize = 4;

pub(crate) struct Raw {
    pub(crate) data: Vec<u8>,
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) stride: usize,
    pub(crate) format: VisualFormat,
}

/// Reads pixels and facts from the display. A drawable of `0` names the root
/// window of the session's screen, for both `describe` and `grab`.
pub(crate) trait Grabber: Send + Sync {
    fn describe(&self, window: u32, deadline: Deadline) -> Result<DrawableInfo, GrabError>;
    fn grab(&self, drawable: u32, rect: GrabRect, deadline: Deadline) -> Result<Raw, GrabError>;
    fn compositing(&self, deadline: Deadline) -> Result<bool, GrabError>;
    fn grab_redirected(
        &self,
        window: u32,
        rect: GrabRect,
        deadline: Deadline,
    ) -> Result<Raw, GrabError>;
}

/// The real grabber: it connects on every call and keeps nothing, because a
/// connection kept between calls would outlive a server that stopped answering.
pub(crate) struct DisplayGrabber;

pub(crate) fn bounded_grab<T: Send + 'static>(
    deadline: Deadline,
    work: impl FnOnce() -> Result<T, GrabError> + Send + 'static,
) -> Result<T, GrabError> {
    start(work)
        .finish(deadline)
        .unwrap_or(Err(GrabError::Timeout))
}

fn display_of(server: DisplayServer) -> Result<String, GrabError> {
    let unreachable = |what: &str| GrabError::Fault(MonitorFault::Unreachable(what.to_owned()));
    match server {
        DisplayServer::X11(display) => Ok(display),
        DisplayServer::Wayland => Err(unreachable("a Wayland session")),
        DisplayServer::Unavailable(_) => Err(unreachable("no display")),
    }
}

fn on_display<T: Send + 'static>(
    deadline: Deadline,
    work: impl FnOnce(&RustConnection, usize) -> Result<T, GrabError> + Send + 'static,
) -> Result<T, GrabError> {
    let display = display_of(session_server())?;
    bounded_grab(deadline, move || {
        let (connection, screen) = crate::system::x11::bounded::connect(&display)
            .map_err(|error| GrabError::Fault(fault_of_connect(&error)))?;
        work(&connection, screen)
    })
}

fn window_of(connection: &RustConnection, screen: usize, id: u32) -> Result<Window, GrabError> {
    match id {
        ROOT => root_of(connection, screen),
        window => Ok(window),
    }
}

pub(in crate::system::x11) fn read_strips(
    connection: &RustConnection,
    drawable: Window,
    rect: GrabRect,
    deadline: Deadline,
    visual: Option<u32>,
) -> Result<Raw, GrabError> {
    let unreadable = GrabError::Fault(MonitorFault::Unreadable);
    if u64::from(rect.width) * u64::from(rect.height) > MAX_PIXELS {
        return Err(GrabError::Resource);
    }
    let limit = connection.maximum_request_bytes();
    let strips = rect.strips(usize::from(rect.width) * WIRE_PIXEL_BYTES, limit)?;
    let mut data =
        Vec::with_capacity(usize::from(rect.width) * usize::from(rect.height) * WIRE_PIXEL_BYTES);
    let mut format = None;
    let mut stride = 0;
    for strip in strips {
        if deadline.is_expired() {
            return Err(GrabError::Timeout);
        }
        let reply = connection
            .get_image(
                ImageFormat::Z_PIXMAP,
                drawable,
                strip.x,
                strip.y,
                strip.width,
                strip.height,
                !0,
            )
            .map_err(|_| GrabError::Fault(MonitorFault::Unreadable))?
            .reply()
            .map_err(|error| reply_error(connection, drawable, error))?;
        let rows = usize::from(strip.height);
        if reply.data.len() % rows != 0 || (stride != 0 && stride != reply.data.len() / rows) {
            return Err(unreadable);
        }
        stride = reply.data.len() / rows;
        if format.is_none() {
            format = Some(
                format_of(
                    connection.setup(),
                    reply.depth,
                    visual.unwrap_or(reply.visual),
                )
                .ok_or(unreadable.clone())?,
            );
        }
        data.extend_from_slice(&reply.data);
    }
    Ok(Raw {
        data,
        width: u32::from(rect.width),
        height: u32::from(rect.height),
        stride,
        format: format.ok_or(unreadable)?,
    })
}

impl Grabber for DisplayGrabber {
    fn describe(&self, window: u32, deadline: Deadline) -> Result<DrawableInfo, GrabError> {
        on_display(deadline, move |connection, screen| {
            let root = root_of(connection, screen)?;
            describe(connection, root, window_of(connection, screen, window)?)
        })
    }

    fn grab(&self, drawable: u32, rect: GrabRect, deadline: Deadline) -> Result<Raw, GrabError> {
        on_display(deadline, move |connection, screen| {
            let target = window_of(connection, screen, drawable)?;
            read_strips(connection, target, rect, deadline, None)
        })
    }

    fn compositing(&self, deadline: Deadline) -> Result<bool, GrabError> {
        on_display(deadline, super::compositing::read)
    }

    fn grab_redirected(
        &self,
        window: u32,
        rect: GrabRect,
        deadline: Deadline,
    ) -> Result<Raw, GrabError> {
        on_display(deadline, move |connection, _| {
            super::composite::grab_redirected(connection, window, rect, deadline)
        })
    }
}

#[cfg(test)]
#[path = "grab_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "grab_live_tests.rs"]
mod live_tests;
