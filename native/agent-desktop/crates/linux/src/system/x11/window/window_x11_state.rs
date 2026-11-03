/// What the display server says about the client of one listed window.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct WindowX11State {
    pub(crate) client_id: u32,
    pub(crate) hidden: bool,
    pub(crate) client_origin: (i32, i32),
    pub(crate) shadow: (i32, i32, i32, i32),
}
