use crate::AdapterError;

/// A live adapter-native connection owned by a persistent host.
///
/// The session may retain platform connection state, such as a Windows COM
/// apartment or Linux D-Bus connection, but must not retain resolved element
/// handles. Elements remain command-scoped so stale identity cannot escape the
/// resolve-and-release boundary.
pub trait AdapterSession: Send + Sync {
    fn close(self: Box<Self>) -> Result<(), AdapterError>;
}

#[cfg(test)]
#[path = "adapter_session_tests.rs"]
mod tests;
