#[repr(i32)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AdDirection {
    Up = 0,
    Down = 1,
    Left = 2,
    Right = 3,
}
