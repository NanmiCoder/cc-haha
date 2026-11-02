#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub(crate) struct HeldInput {
    pub(crate) keys: Vec<u8>,
    pub(crate) buttons: Vec<u8>,
}
