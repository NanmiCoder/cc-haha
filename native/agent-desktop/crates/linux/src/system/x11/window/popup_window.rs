use crate::tree::Extents;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct PopupWindow {
    pub(crate) id: u32,
    pub(crate) bounds: Extents,
}
