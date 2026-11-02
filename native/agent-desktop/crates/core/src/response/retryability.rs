#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) enum Retryability {
    #[default]
    Unspecified,
    Retryable,
    NonRetryable,
}

impl Retryability {
    pub(crate) fn from_details(details: &serde_json::Value) -> Self {
        match details
            .get("retryable")
            .and_then(serde_json::Value::as_bool)
        {
            Some(true) => Self::Retryable,
            Some(false) => Self::NonRetryable,
            None => Self::Unspecified,
        }
    }
}
