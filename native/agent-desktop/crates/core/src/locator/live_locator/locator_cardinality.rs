#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LocatorCardinality {
    Zero,
    One,
    Many { observed: u32, exact: bool },
    Incomplete { observed: u32 },
}
