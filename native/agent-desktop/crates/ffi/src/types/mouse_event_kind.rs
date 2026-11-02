#[repr(i32)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AdMouseEventKind {
    Move = 0,
    Down = 1,
    Up = 2,
    Click = 3,
}
