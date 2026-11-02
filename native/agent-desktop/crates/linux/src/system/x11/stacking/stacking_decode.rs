use crate::system::x11::FrameExtents;
use crate::system::x11::snapshot::decode_cardinals;
use crate::system::x11::stacking::type_atoms::TypeAtoms;
use crate::system::x11::window::desktop_placement::DesktopPlacement;
use crate::system::x11::window::window_kind::WindowKind;
use crate::tree::Extents;

const STICKY_DESKTOP: u32 = 0xFFFF_FFFF;

/// The atom ids of the `_NET_WM_STATE` values the verdict reads.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct StateAtoms {
    pub(crate) hidden: u32,
    pub(crate) above: u32,
}

/// The windows probed above and including a target at most this many: more
/// than the cap leaves the topmost windows unread, which is unknown and never a
/// shorter answer.
pub(crate) const MAX_ENTRIES: usize = 256;

/// Whether `count` windows are more than a read probes.
pub(crate) fn exceeds_cap(count: usize) -> bool {
    count > MAX_ENTRIES
}

/// A property reply as `(format, bytes)`, or `None` when the value was cut
/// short by the length asked for (`bytes_after` is not zero).
pub(crate) fn complete_value(
    format: u8,
    value: Vec<u8>,
    bytes_after: u32,
) -> Option<(u8, Vec<u8>)> {
    (bytes_after == 0).then_some((format, value))
}

/// Whether `_NET_WM_STATE` carries the hidden and above atoms. An atom the
/// verdict does not read is ignored; a property that cannot be decoded
/// carries neither.
pub(crate) fn decode_state(format: u8, bytes: &[u8], atoms: StateAtoms) -> (bool, bool) {
    let listed = decode_cardinals(format, bytes).unwrap_or_default();
    (
        listed.contains(&atoms.hidden),
        listed.contains(&atoms.above),
    )
}

/// `_NET_WM_DESKTOP`: `0xFFFFFFFF` is every desktop.
pub(crate) fn decode_desktop(format: u8, bytes: &[u8]) -> DesktopPlacement {
    match decode_cardinals(format, bytes).as_deref() {
        Some([STICKY_DESKTOP]) => DesktopPlacement::Sticky,
        Some([index]) => DesktopPlacement::On(*index),
        _ => DesktopPlacement::Unknown,
    }
}

/// `_NET_CURRENT_DESKTOP`.
pub(crate) fn decode_current_desktop(format: u8, bytes: &[u8]) -> Option<u32> {
    match decode_cardinals(format, bytes)?.as_slice() {
        [index] => Some(*index),
        _ => None,
    }
}

/// The kind a window's first listed `_NET_WM_WINDOW_TYPE` names. A window
/// with no type is a normal one; a type the verdict has no use for is
/// `Other`.
pub(crate) fn decode_kind(format: u8, bytes: &[u8], atoms: TypeAtoms) -> WindowKind {
    let Some(first) = decode_cardinals(format, bytes).and_then(|list| list.first().copied()) else {
        return WindowKind::Normal;
    };
    match first {
        atom if atom == atoms.normal => WindowKind::Normal,
        atom if atom == atoms.dialog => WindowKind::Dialog,
        atom if atom == atoms.utility => WindowKind::Utility,
        atom if atoms.menu.contains(&atom) => WindowKind::Menu,
        atom if atom == atoms.dock => WindowKind::Dock,
        atom if atom == atoms.desktop => WindowKind::Desktop,
        _ => WindowKind::Other,
    }
}

/// The rectangle the window manager draws around a client: the client
/// rectangle grown by `_NET_FRAME_EXTENTS` (left, right, top, bottom).
pub(crate) fn frame_rectangle(client: Extents, extents: Option<FrameExtents>) -> Extents {
    let Some(border) = extents else {
        return client;
    };
    let grow = |value: u32| i32::try_from(value).unwrap_or(0);
    Extents {
        x: client.x - grow(border.left),
        y: client.y - grow(border.top),
        width: client.width + grow(border.left) + grow(border.right),
        height: client.height + grow(border.top) + grow(border.bottom),
    }
}

#[cfg(test)]
#[path = "stacking_decode_tests.rs"]
mod tests;
