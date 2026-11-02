use crate::{AdapterError, AppError, ErrorCode};

pub(crate) fn reject(command: &str, replacement: &str) -> AppError {
    AdapterError::new(
        ErrorCode::ActionNotSupported,
        format!("{command} is unavailable in stateless mode"),
    )
    .with_suggestion(format!(
        "Use the atomic {replacement} command; held input requires a daemon-owned transaction that can guarantee release"
    ))
    .into()
}
