#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct KeysymStep {
    pub(crate) keysym: u32,
    pub(crate) down: bool,
}
