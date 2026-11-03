use x11rb::protocol::xproto::Window;

pub(in crate::system::x11) struct RootStackEvidence {
    pub(in crate::system::x11) viewable: bool,
    pub(in crate::system::x11) override_redirect: bool,
    pub(in crate::system::x11) siblings: Vec<Window>,
    pub(in crate::system::x11) managed_frames: Vec<(Window, Window)>,
}
