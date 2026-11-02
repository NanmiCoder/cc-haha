use serde::Serialize;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct LocatorReadHealth {
    pub cannot_complete: u64,
    pub native_read_failures: u64,
    pub deadline_exhausted: u64,
}
