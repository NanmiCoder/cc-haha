#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LocatorSelection {
    Strict,
    All { limit: Option<u32> },
    Count,
    First,
    Last,
    Nth(u32),
}
