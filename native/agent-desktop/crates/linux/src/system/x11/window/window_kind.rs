/// What a window manager's window type says a window is for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WindowKind {
    Normal,
    Dialog,
    Utility,
    Menu,
    Dock,
    Desktop,
    Other,
}
