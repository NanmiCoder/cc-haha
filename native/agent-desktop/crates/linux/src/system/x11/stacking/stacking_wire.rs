use x11rb::connection::Connection;
use x11rb::cookie::Cookie;
use x11rb::errors::ReplyError;
use x11rb::protocol::xproto::{
    Atom, AtomEnum, ConnectionExt, GetGeometryReply, GetPropertyReply, GetWindowAttributesReply,
    MapState, TranslateCoordinatesReply, Window, WindowClass,
};
use x11rb::rust_connection::RustConnection;

use self::selection::{frame_of, read_override_selection};
use super::overlays::Overlays;
use crate::system::x11::snapshot::{
    decode_cardinals, decode_frame_extents, decode_shadow, decode_title,
};
use crate::system::x11::stacking::stacked_window::StackedWindow;
use crate::system::x11::stacking::stacking_atoms::{WindowAtoms, names};
use crate::system::x11::stacking::stacking_decode::{
    complete_value, decode_current_desktop, decode_desktop, decode_kind, decode_state, exceeds_cap,
};
use crate::system::x11::stacking::stacking_read::StackingRead;
use crate::system::x11::stacking::stacking_snapshot::StackingSnapshot;
use crate::system::x11::window::desktop_placement::DesktopPlacement;
use crate::system::x11::window::window_flags::WindowFlags;
use crate::tree::Extents;

const MAX_STACK: u32 = 4_096;
const MAX_OVERLAYS: usize = 64;
const TYPE_LONGS: u32 = 8;
const STATE_LONGS: u32 = 64;
const MAX_TITLE_LONGS: u32 = 1_024;

#[path = "stacking_wire_select.rs"]
mod selection;

type Property<'c> = Cookie<'c, RustConnection, GetPropertyReply>;

fn property(
    connection: &RustConnection,
    window: Window,
    name: Atom,
    kind: impl Into<Atom>,
    longs: u32,
) -> Option<Property<'_>> {
    connection
        .get_property(false, window, name, kind, 0, longs)
        .ok()
}

/// Why a reply left nothing to use: the window no longer exists (an X
/// error, so nothing of it can cover anything), or the read failed and leaves
/// the evidence short.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Stop {
    Gone,
    Failed,
}

type Got<T> = Result<T, Stop>;

fn answer<T: x11rb::x11_utils::TryParse>(cookie: Option<Cookie<'_, RustConnection, T>>) -> Got<T> {
    match cookie.map(|cookie| cookie.reply()) {
        Some(Ok(value)) => Ok(value),
        Some(Err(ReplyError::X11Error(_))) => Err(Stop::Gone),
        Some(Err(ReplyError::ConnectionError(_))) | None => Err(Stop::Failed),
    }
}

/// A property value as `(format, bytes)`, empty when the property is absent.
/// A value cut short by the length asked for is a failed read, because the
/// part not read may hold the atom that decides.
fn value(cookie: Option<Property<'_>>) -> Got<(u8, Vec<u8>)> {
    let reply = answer(cookie)?;
    complete_value(reply.format, reply.value, reply.bytes_after).ok_or(Stop::Failed)
}

struct Pending<'c> {
    id: Window,
    state: Option<Property<'c>>,
    desktop: Option<Property<'c>>,
    kind: Option<Property<'c>>,
    extents: Option<Property<'c>>,
    shadow: Option<Property<'c>>,
    rest: Geometry<'c>,
}

struct Geometry<'c> {
    attributes: Option<Cookie<'c, RustConnection, GetWindowAttributesReply>>,
    origin: Option<Cookie<'c, RustConnection, TranslateCoordinatesReply>>,
    size: Option<Cookie<'c, RustConnection, GetGeometryReply>>,
}

fn geometry(connection: &RustConnection, root: Window, id: Window) -> Geometry<'_> {
    Geometry {
        attributes: connection.get_window_attributes(id).ok(),
        origin: connection.translate_coordinates(id, root, 0, 0).ok(),
        size: connection.get_geometry(id).ok(),
    }
}

fn request<'c>(
    connection: &'c RustConnection,
    names: &WindowAtoms,
    root: Window,
    id: Window,
) -> Pending<'c> {
    Pending {
        id,
        state: property(connection, id, names.state, AtomEnum::ATOM, STATE_LONGS),
        desktop: property(connection, id, names.desktop, AtomEnum::CARDINAL, 1),
        kind: property(connection, id, names.kind, AtomEnum::ATOM, TYPE_LONGS),
        extents: property(connection, id, names.frame_extents, AtomEnum::CARDINAL, 4),
        shadow: property(connection, id, names.gtk_extents, AtomEnum::CARDINAL, 4),
        rest: geometry(connection, root, id),
    }
}

fn client_rectangle(rest: Geometry<'_>) -> Got<(bool, Extents)> {
    let attributes = answer(rest.attributes);
    let origin = answer(rest.origin);
    let size = answer(rest.size);
    let (attributes, origin, size) = (attributes?, origin?, size?);
    Ok((
        attributes.map_state == MapState::VIEWABLE,
        Extents {
            x: i32::from(origin.dst_x),
            y: i32::from(origin.dst_y),
            width: i32::from(size.width),
            height: i32::from(size.height),
        },
    ))
}

fn shadow_of(cookie: Option<Property<'_>>) -> (i32, i32, i32, i32) {
    value(cookie).ok().map_or((0, 0, 0, 0), |(format, bytes)| {
        decode_shadow(format, &bytes)
    })
}

fn collect(pending: Pending<'_>, atoms: &WindowAtoms) -> Got<StackedWindow> {
    let (mapped, client) = client_rectangle(pending.rest)?;
    let shadow = shadow_of(pending.shadow);
    let (state, desktop, kind, extents) = (
        value(pending.state),
        value(pending.desktop),
        value(pending.kind),
        value(pending.extents),
    );
    let (hidden, above) = {
        let (format, bytes) = state?;
        decode_state(format, &bytes, atoms.states)
    };
    let desktop = {
        let (format, bytes) = desktop?;
        decode_desktop(format, &bytes)
    };
    let kind = {
        let (format, bytes) = kind?;
        decode_kind(format, &bytes, atoms.types)
    };
    let extents = {
        let (format, bytes) = extents?;
        decode_frame_extents(format, &bytes).unwrap_or_default()
    };
    Ok(StackedWindow {
        id: pending.id,
        flags: WindowFlags {
            hidden,
            above,
            mapped,
        },
        desktop,
        kind,
        client,
        extents,
        shadow,
    })
}

/// The mapped override-redirect windows above `frame`. A sibling that is gone
/// is skipped; a read that failed, or more siblings than are probed, leaves
/// the answer unknown.
fn overlays(connection: &RustConnection, root: Window, frame: Window) -> Got<Overlays> {
    let siblings = answer(connection.query_tree(root).ok())?.children;
    overlays_from_siblings(connection, &siblings, frame)
}

fn overlays_from_siblings(
    connection: &RustConnection,
    siblings: &[Window],
    frame: Window,
) -> Got<Overlays> {
    let position = siblings
        .iter()
        .position(|window| *window == frame)
        .ok_or(Stop::Failed)?;
    let above = &siblings[position + 1..];
    if exceeds_cap(above.len()) {
        return Err(Stop::Failed);
    }
    let probes: Vec<_> = above
        .iter()
        .map(|window| {
            (
                connection.get_window_attributes(*window).ok(),
                connection.get_geometry(*window).ok(),
                super::stacking_input::request(connection, *window),
            )
        })
        .collect();
    let mut found = Overlays::default();
    for (window, (attributes, size, input)) in above.iter().zip(probes) {
        let attributes = match answer(attributes) {
            Ok(attributes) => attributes,
            Err(Stop::Gone) => continue,
            Err(Stop::Failed) => return Err(Stop::Failed),
        };
        let paints = attributes.class == WindowClass::INPUT_OUTPUT;
        if !attributes.override_redirect || attributes.map_state != MapState::VIEWABLE || !paints {
            continue;
        }
        let size = match answer(size) {
            Ok(size) => size,
            Err(Stop::Gone) => continue,
            Err(Stop::Failed) => return Err(Stop::Failed),
        };
        if crate::system::overlay::cursor_overlay::is_overlay(
            connection,
            *window,
            &attributes,
            &size,
        )
        .map_err(|_| Stop::Failed)?
        {
            continue;
        }
        let border = i32::from(size.border_width) * 2;
        found.bounds.push(Extents {
            x: i32::from(size.x),
            y: i32::from(size.y),
            width: i32::from(size.width) + border,
            height: i32::from(size.height) + border,
        });
        let inside = i32::from(size.border_width);
        let origin = (i32::from(size.x) + inside, i32::from(size.y) + inside);
        found.receiving.extend(
            super::stacking_input::rectangles(input, origin)
                .into_iter()
                .map(|rect| (*window, rect)),
        );
        if found.bounds.len() == MAX_OVERLAYS {
            return Err(Stop::Failed);
        }
    }
    found.names = titles(connection, &found.receiving)?;
    Ok(found)
}

/// The titles of the windows that take the pointer, `_NET_WM_NAME` first and
/// `WM_NAME` after, one read per window however many rectangles it has.
fn titles(connection: &RustConnection, receiving: &[(u32, Extents)]) -> Got<Vec<(u32, String)>> {
    let mut ids: Vec<u32> = receiving.iter().map(|(id, _)| *id).collect();
    ids.dedup();
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let atom = |name: &[u8]| answer(connection.intern_atom(false, name).ok()).map(|r| r.atom);
    let (wide_name, utf8) = (atom(b"_NET_WM_NAME")?, atom(b"UTF8_STRING")?);
    let reads: Vec<_> = ids
        .iter()
        .map(|id| {
            (
                property(connection, *id, wide_name, utf8, MAX_TITLE_LONGS),
                property(
                    connection,
                    *id,
                    AtomEnum::WM_NAME.into(),
                    AtomEnum::STRING,
                    MAX_TITLE_LONGS,
                ),
            )
        })
        .collect();
    let mut named = Vec::new();
    for (id, (wide, narrow)) in ids.into_iter().zip(reads) {
        let (wide, narrow) = match (value(wide), value(narrow)) {
            (Ok(wide), Ok(narrow)) => (wide, narrow),
            (Err(Stop::Failed), _) | (_, Err(Stop::Failed)) => return Err(Stop::Failed),
            _ => continue,
        };
        let title = decode_title(
            Some((wide.0, wide.1.as_slice())),
            Some((narrow.0, narrow.1.as_slice())),
        );
        if !title.is_empty() {
            named.push((id, title));
        }
    }
    Ok(named)
}

/// The stacking evidence for one client on the display `display`: the
/// target and every managed client above it, bottom to top, and the mapped
/// override-redirect windows above the target's frame. Evidence that is short
/// by a failed reply or a cap is `Unavailable`, never a smaller `Ready`.
pub(in crate::system::x11) fn read_stacking(display: &str, target: u32) -> StackingRead {
    let Ok((connection, screen)) = crate::system::x11::bounded::connect(display) else {
        return StackingRead::Unavailable;
    };
    let Some(root) = connection
        .setup()
        .roots
        .get(screen)
        .map(|screen| screen.root)
    else {
        return StackingRead::Unavailable;
    };
    let Some(names) = names(&connection) else {
        return StackingRead::Unavailable;
    };
    let manager = property(&connection, root, names.root.wm_check, AtomEnum::WINDOW, 1);
    let stack = property(
        &connection,
        root,
        names.root.stacking,
        AtomEnum::WINDOW,
        MAX_STACK,
    );
    let desktop = property(
        &connection,
        root,
        names.root.current_desktop,
        AtomEnum::CARDINAL,
        1,
    );
    let has_manager = value(manager).is_ok_and(|(_, bytes)| !bytes.is_empty());
    if !has_manager {
        return StackingRead::NoManager;
    }
    let Some(listed) = value(stack)
        .ok()
        .and_then(|(format, bytes)| decode_cardinals(format, &bytes))
    else {
        return StackingRead::Unavailable;
    };
    let current_desktop = value(desktop)
        .ok()
        .and_then(|(format, bytes)| decode_current_desktop(format, &bytes));
    let (selected_ids, is_override_target, override_overlays) =
        if let Some(position) = listed.iter().position(|window| *window == target) {
            (listed[position..].to_vec(), false, None)
        } else {
            let Ok(selection) = read_override_selection(&connection, root, target, &listed) else {
                return StackingRead::Unavailable;
            };
            (selection.ids, true, Some(selection.overlays))
        };
    if exceeds_cap(selected_ids.len()) {
        return StackingRead::Unavailable;
    }
    let pending: Vec<_> = selected_ids
        .iter()
        .map(|window| request(&connection, &names.window, root, *window))
        .collect();
    let mut stack = Vec::with_capacity(pending.len());
    for entry in pending {
        match collect(entry, &names.window) {
            Ok(window) => stack.push(window),
            Err(Stop::Gone) => {}
            Err(Stop::Failed) => return StackingRead::Unavailable,
        }
    }
    if stack.first().is_none_or(|window| window.id != target) {
        return StackingRead::Unavailable;
    }
    if is_override_target {
        let Some(target_window) = stack.first_mut().filter(|window| window.flags.mapped) else {
            return StackingRead::Unavailable;
        };
        target_window.desktop =
            current_desktop.map_or(DesktopPlacement::Unknown, DesktopPlacement::On);
    };
    let overlays = if let Some(overlays) = override_overlays {
        overlays
    } else {
        let Ok(overlays) = frame_of(&connection, root, target)
            .and_then(|frame| overlays(&connection, root, frame))
        else {
            return StackingRead::Unavailable;
        };
        overlays
    };
    StackingRead::Ready(StackingSnapshot {
        current_desktop,
        stack,
        override_redirect_above: overlays.bounds,
        override_redirect_receiving: overlays.receiving,
        override_redirect_names: overlays.names,
    })
}
