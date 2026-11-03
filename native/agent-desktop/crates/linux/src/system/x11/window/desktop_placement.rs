/// Which virtual desktop a window lives on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DesktopPlacement {
    Sticky,
    On(u32),
    Unknown,
}
