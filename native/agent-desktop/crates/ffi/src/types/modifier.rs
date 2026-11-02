#[repr(i32)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AdModifier {
    Meta = 0,
    Ctrl = 1,
    Alt = 2,
    Shift = 3,
}

pub const AD_MODIFIER_CMD: i32 = 0;
