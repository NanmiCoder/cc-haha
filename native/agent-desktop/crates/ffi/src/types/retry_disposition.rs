#[repr(i32)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AdRetryDisposition {
    Unknown = 0,
    Safe = 1,
    Unsafe = 2,
}

impl From<agent_desktop_core::RetryDisposition> for AdRetryDisposition {
    fn from(value: agent_desktop_core::RetryDisposition) -> Self {
        match value {
            agent_desktop_core::RetryDisposition::Unknown => Self::Unknown,
            agent_desktop_core::RetryDisposition::Safe => Self::Safe,
            agent_desktop_core::RetryDisposition::Unsafe => Self::Unsafe,
        }
    }
}
