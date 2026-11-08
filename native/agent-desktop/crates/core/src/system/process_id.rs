use serde::{Deserialize, Serialize};

#[repr(transparent)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ProcessId(u32);

impl ProcessId {
    pub const fn new(value: u32) -> Self {
        Self(value)
    }

    pub const fn get(self) -> u32 {
        self.0
    }
}

impl From<u32> for ProcessId {
    fn from(value: u32) -> Self {
        Self::new(value)
    }
}

impl From<ProcessId> for u32 {
    fn from(value: ProcessId) -> Self {
        value.get()
    }
}

impl PartialEq<u32> for ProcessId {
    fn eq(&self, other: &u32) -> bool {
        self.get() == *other
    }
}

impl PartialEq<ProcessId> for u32 {
    fn eq(&self, other: &ProcessId) -> bool {
        *self == other.get()
    }
}

impl TryFrom<i32> for ProcessId {
    type Error = std::num::TryFromIntError;

    fn try_from(value: i32) -> Result<Self, Self::Error> {
        u32::try_from(value).map(Self::new)
    }
}

impl TryFrom<ProcessId> for i32 {
    type Error = std::num::TryFromIntError;

    fn try_from(value: ProcessId) -> Result<Self, Self::Error> {
        i32::try_from(value.get())
    }
}

impl std::fmt::Display for ProcessId {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.0.fmt(formatter)
    }
}

#[cfg(test)]
#[path = "process_id_tests.rs"]
mod tests;
