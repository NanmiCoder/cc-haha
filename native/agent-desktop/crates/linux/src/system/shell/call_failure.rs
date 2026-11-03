#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum CallFailure {
    NoService,
    Transport(String),
}
