use agent_desktop_core::{AdapterError, ErrorCode};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum SinkError {
    Closed,
    Request(String),
    Journal(String),
}

impl SinkError {
    pub(crate) fn into_adapter(self) -> AdapterError {
        match self {
            Self::Closed => AdapterError::new(
                ErrorCode::ActionFailed,
                "The display connection closed while input was being sent",
            ),
            Self::Request(detail) => AdapterError::new(
                ErrorCode::ActionFailed,
                "The display server rejected an input request",
            )
            .with_platform_detail(detail),
            Self::Journal(detail) => AdapterError::new(
                ErrorCode::ActionFailed,
                "The record of held input could not be written, so no further input was sent",
            )
            .with_platform_detail(detail),
        }
    }
}
