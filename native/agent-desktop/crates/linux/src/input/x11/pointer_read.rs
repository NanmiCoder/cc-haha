#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct PointerRead {
    pub(crate) x: i32,
    pub(crate) y: i32,
    pub(crate) mask: u16,
}
