use x11rb::protocol::xproto::Atom;

pub(in crate::system::x11) const MESSAGE_LONGS: usize = 5;

pub(in crate::system::x11) const FORMAT_LONGS: u8 = 32;

pub(in crate::system::x11) type MessageData = [u32; MESSAGE_LONGS];

/// The source indication of a request: 2 says a pager or automation tool is
/// asking, the form `xdotool` and `wmctrl` send.
pub(in crate::system::x11) const SOURCE_TOOL: u32 = 2;

/// The gravity of a `_NET_MOVERESIZE_WINDOW` request that places the window.
/// Static gravity (10) makes x and y the position of the client rectangle,
/// not of the frame the window manager draws around it.
pub(in crate::system::x11) const MOVE_GRAVITY: u32 = 10;

/// The gravity of a request that only resizes. Gravity 0 takes the window's
/// own hint, which kept the position of GTK3, GTK4 and Qt clients under
/// openbox; static gravity moved GTK clients and north-west gravity moved Qt
/// clients by the frame extents.
pub(in crate::system::x11) const RESIZE_GRAVITY: u32 = 0;

const FLAG_X: u32 = 1 << 8;
const FLAG_Y: u32 = 1 << 9;
const FLAG_WIDTH: u32 = 1 << 10;
const FLAG_HEIGHT: u32 = 1 << 11;
const SOURCE_SHIFT: u32 = 12;
const ICONIC_STATE: u32 = 3;

/// `_NET_MOVERESIZE_WINDOW`: only the fields that are `Some` are flagged, the
/// others are sent as zero. A request that places the window uses static
/// gravity and one that only resizes it uses the window's own gravity.
pub(in crate::system::x11) fn move_resize(
    x: Option<i32>,
    y: Option<i32>,
    width: Option<u32>,
    height: Option<u32>,
) -> MessageData {
    let gravity = if x.is_some() || y.is_some() {
        MOVE_GRAVITY
    } else {
        RESIZE_GRAVITY
    };
    let flags = gravity
        | (u32::from(x.is_some()) * FLAG_X)
        | (u32::from(y.is_some()) * FLAG_Y)
        | (u32::from(width.is_some()) * FLAG_WIDTH)
        | (u32::from(height.is_some()) * FLAG_HEIGHT)
        | (SOURCE_TOOL << SOURCE_SHIFT);
    [
        flags,
        x.unwrap_or(0) as u32,
        y.unwrap_or(0) as u32,
        width.unwrap_or(0),
        height.unwrap_or(0),
    ]
}

/// `_NET_WM_STATE` adding or removing both maximized atoms in one message.
pub(in crate::system::x11) fn maximize(add: bool, vertical: Atom, horizontal: Atom) -> MessageData {
    let action = u32::from(add);
    [action, vertical, horizontal, SOURCE_TOOL, 0]
}

/// ICCCM `WM_CHANGE_STATE` asking for the iconic state.
pub(in crate::system::x11) fn iconify() -> MessageData {
    [ICONIC_STATE, 0, 0, 0, 0]
}

/// `_NET_ACTIVE_WINDOW` from a tool with timestamp 0, the form that
/// un-minimized GTK3, GTK4 and Qt windows every time under mutter, where a
/// server-time stamp did not.
pub(crate) fn activate() -> MessageData {
    [SOURCE_TOOL, 0, 0, 0, 0]
}

/// `_NET_CLOSE_WINDOW` stamped with the server time of the request.
pub(in crate::system::x11) fn close(timestamp: u32) -> MessageData {
    [timestamp, SOURCE_TOOL, 0, 0, 0]
}
