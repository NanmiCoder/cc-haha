use x11rb::cookie::Cookie;
use x11rb::protocol::shape::{ConnectionExt, GetRectanglesReply, SK};
use x11rb::protocol::xproto::Window;
use x11rb::rust_connection::RustConnection;

use crate::tree::Extents;

pub(in crate::system::x11) type InputRequest<'c> =
    Option<Cookie<'c, RustConnection, GetRectanglesReply>>;

pub(in crate::system::x11) fn request(
    connection: &RustConnection,
    window: Window,
) -> InputRequest<'_> {
    connection.shape_get_rectangles(window, SK::INPUT).ok()
}

/// The input region of a window as rectangles in root coordinates, `origin`
/// being the window's inside corner. A region that could not be read is
/// empty, which claims nothing.
pub(in crate::system::x11) fn rectangles(
    request: InputRequest<'_>,
    origin: (i32, i32),
) -> Vec<Extents> {
    let Some(reply) = request.and_then(|cookie| cookie.reply().ok()) else {
        return Vec::new();
    };
    reply
        .rectangles
        .into_iter()
        .map(|rect| Extents {
            x: origin.0 + i32::from(rect.x),
            y: origin.1 + i32::from(rect.y),
            width: i32::from(rect.width),
            height: i32::from(rect.height),
        })
        .collect()
}
