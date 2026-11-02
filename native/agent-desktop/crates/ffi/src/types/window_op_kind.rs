#[repr(i32)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AdWindowOpKind {
    Resize = 0,
    Move = 1,
    Minimize = 2,
    Maximize = 3,
    Restore = 4,
}
