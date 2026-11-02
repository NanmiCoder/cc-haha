#[repr(i32)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AdFindSelectionKind {
    Strict = 0,
    First = 1,
    Last = 2,
    Nth = 3,
}

impl AdFindSelectionKind {
    pub(crate) fn from_c(value: i32) -> Option<Self> {
        match value {
            0 => Some(Self::Strict),
            1 => Some(Self::First),
            2 => Some(Self::Last),
            3 => Some(Self::Nth),
            _ => None,
        }
    }
}
