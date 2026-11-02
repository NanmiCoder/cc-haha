#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct KeymapEdit {
    pub(crate) keycode: u8,
    pub(crate) keysyms: Vec<u32>,
}
