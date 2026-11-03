use std::time::{Duration, Instant};

use agent_desktop_core::Deadline;
use x11rb::connection::Connection;
use x11rb::protocol::composite::{ConnectionExt as _, Redirect};
use x11rb::protocol::xproto::{ConnectionExt as _, Window, WindowClass};
use x11rb::rust_connection::RustConnection;

use super::drawable::reply_error;
use super::grab::{Raw, read_strips};
use super::grab_error::{GrabError, unreadable};
use super::grab_rect::GrabRect;
use super::map_state::MapState;
use super::repaint::Repaint;
use super::unpainted::{Region, is_proven};

const PAINT_WAIT: Duration = Duration::from_millis(1_000);
const PAINT_POLL: Duration = Duration::from_millis(40);

fn screen_under(
    connection: &RustConnection,
    window: Window,
    rect: GrabRect,
    deadline: Deadline,
) -> Option<Raw> {
    let root = connection.get_geometry(window).ok()?.reply().ok()?.root;
    let origin = connection
        .translate_coordinates(window, root, 0, 0)
        .ok()?
        .reply()
        .ok()?;
    let area = GrabRect {
        x: origin.dst_x.checked_add(rect.x)?,
        y: origin.dst_y.checked_add(rect.y)?,
        width: rect.width,
        height: rect.height,
    };
    read_strips(connection, root, area, deadline, None).ok()
}

fn content_regions(connection: &RustConnection, window: Window, rect: GrabRect) -> Vec<Region> {
    let children = connection
        .query_tree(window)
        .ok()
        .and_then(|cookie| cookie.reply().ok())
        .map(|tree| tree.children)
        .unwrap_or_default();
    let found: Vec<Region> = children
        .into_iter()
        .filter_map(|child| {
            let attributes = connection.get_window_attributes(child).ok()?.reply().ok()?;
            let size = connection.get_geometry(child).ok()?.reply().ok()?;
            let paints = attributes.class == WindowClass::INPUT_OUTPUT;
            (paints && MapState::from(attributes.map_state) == MapState::Viewable).then_some(
                Region {
                    x: i32::from(size.x) - i32::from(rect.x),
                    y: i32::from(size.y) - i32::from(rect.y),
                    width: i32::from(size.width),
                    height: i32::from(size.height),
                },
            )
        })
        .max_by_key(|region| i64::from(region.width) * i64::from(region.height))
        .into_iter()
        .collect();
    if found.is_empty() {
        vec![Region {
            x: 0,
            y: 0,
            width: i32::from(rect.width),
            height: i32::from(rect.height),
        }]
    } else {
        found
    }
}

fn painted(
    connection: &RustConnection,
    pixmap: Window,
    rect: GrabRect,
    visual: u32,
    deadline: Deadline,
) -> Result<Raw, GrabError> {
    let started = Instant::now();
    loop {
        let raw = read_strips(connection, pixmap, rect, deadline, Some(visual))?;
        if raw.data.iter().any(|byte| *byte != 0) {
            return Ok(raw);
        }
        if deadline.is_expired() {
            return Err(GrabError::Timeout);
        }
        if started.elapsed() >= PAINT_WAIT {
            return Err(GrabError::UnprovenPaint);
        }
        std::thread::sleep(PAINT_POLL.min(deadline.remaining()));
    }
}

/// Reads a mapped window's own pixels through a Composite redirect, so a
/// window another window covers still gives its own paint. The redirect
/// lasts only for this read. A pixmap that is still blank after the wait is
/// refused: it is a window not painted yet, never an image to return. A
/// pixmap that equals what the screen shows under the window, with no repaint
/// seen, holds only that copy, so it is refused as well. So is any pixmap
/// whose provenance is not proven for the whole target: a partial repaint
/// report, a missing screen read and a pixmap that matches the screen in any
/// pixel prove nothing.
pub(crate) fn grab_redirected(
    connection: &RustConnection,
    window: Window,
    rect: GrabRect,
    deadline: Deadline,
) -> Result<Raw, GrabError> {
    connection
        .composite_query_version(0, 4)
        .map_err(unreadable)?
        .reply()
        .map_err(unreadable)?;
    let attributes = connection
        .get_window_attributes(window)
        .map_err(unreadable)?
        .reply()
        .map_err(|error| reply_error(connection, window, error))?;
    if MapState::from(attributes.map_state) != MapState::Viewable {
        return Err(GrabError::Unviewable);
    }
    let screen = screen_under(connection, window, rect, deadline);
    let regions = content_regions(connection, window, rect);
    let repaint = Repaint::watch(connection, window);
    connection
        .composite_redirect_window(window, Redirect::AUTOMATIC)
        .map_err(unreadable)?
        .check()
        .map_err(unreadable)?;
    let pixmap = connection.generate_id().map_err(unreadable);
    let result = pixmap.and_then(|pixmap| {
        let named = connection
            .composite_name_window_pixmap(window, pixmap)
            .map_err(unreadable)?
            .check()
            .map_err(unreadable);
        let repainted = repaint
            .as_ref()
            .is_some_and(|repaint| repaint.settle(deadline, rect));
        let raw = named
            .and_then(|()| painted(connection, pixmap, rect, attributes.visual, deadline))
            .and_then(|raw| {
                let proven = is_proven(repainted, screen.as_ref(), &raw, &regions);
                if proven {
                    Ok(raw)
                } else {
                    Err(GrabError::UnprovenPaint)
                }
            });
        let _ = connection.free_pixmap(pixmap);
        raw
    });
    let _ = connection.composite_unredirect_window(window, Redirect::AUTOMATIC);
    let _ = connection.flush();
    result
}
