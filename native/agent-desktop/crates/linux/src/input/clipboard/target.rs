#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Target {
    pub(crate) name: String,
    pub(crate) bytes: Vec<u8>,
}
