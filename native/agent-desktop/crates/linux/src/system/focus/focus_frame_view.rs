/// What the window's own frame says about itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(in crate::system) struct FrameView {
    pub(in crate::system) minimized: Option<bool>,
    pub(in crate::system) active: Option<bool>,
    pub(in crate::system) modal: Option<bool>,
    pub(in crate::system) dialog: bool,
}
