use super::window_kind::WindowKind;

/// One top-level window of a process.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Toplevel {
    pub(crate) id: u32,
    pub(crate) title: String,
    pub(crate) kind: WindowKind,
    pub(crate) transient: bool,
}
