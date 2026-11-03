use x11rb::protocol::xproto::Window;

use super::overlays::Overlays;

pub(in crate::system::x11) struct StackSelection {
    pub(in crate::system::x11) ids: Vec<Window>,
    pub(in crate::system::x11) overlays: Overlays,
}
