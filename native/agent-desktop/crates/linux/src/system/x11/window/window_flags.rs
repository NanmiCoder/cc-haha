/// The window-manager state bits of one client that the stacking verdict reads.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct WindowFlags {
    pub(crate) hidden: bool,
    pub(crate) above: bool,
    pub(crate) mapped: bool,
}
