#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct KeyLookup {
    pub(crate) code: u8,
    pub(crate) shift: bool,
}
