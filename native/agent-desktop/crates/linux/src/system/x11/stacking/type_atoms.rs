/// The atom ids of the `_NET_WM_WINDOW_TYPE` values that name a kind.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct TypeAtoms {
    pub(crate) normal: u32,
    pub(crate) dialog: u32,
    pub(crate) utility: u32,
    pub(crate) menu: [u32; 3],
    pub(crate) dock: u32,
    pub(crate) desktop: u32,
}
