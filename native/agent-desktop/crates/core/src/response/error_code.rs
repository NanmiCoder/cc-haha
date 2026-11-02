use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ErrorCode {
    PermDenied,
    ElementNotFound,
    AppNotFound,
    ActionFailed,
    ActionNotSupported,
    StaleRef,
    AmbiguousTarget,
    WindowNotFound,
    PlatformNotSupported,
    Timeout,
    InvalidArgs,
    NotificationNotFound,
    SnapshotNotFound,
    PolicyDenied,
    AppUnresponsive,
    Internal,
}

impl ErrorCode {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::PermDenied => "PERM_DENIED",
            Self::ElementNotFound => "ELEMENT_NOT_FOUND",
            Self::AppNotFound => "APP_NOT_FOUND",
            Self::ActionFailed => "ACTION_FAILED",
            Self::ActionNotSupported => "ACTION_NOT_SUPPORTED",
            Self::StaleRef => "STALE_REF",
            Self::AmbiguousTarget => "AMBIGUOUS_TARGET",
            Self::WindowNotFound => "WINDOW_NOT_FOUND",
            Self::PlatformNotSupported => "PLATFORM_NOT_SUPPORTED",
            Self::Timeout => "TIMEOUT",
            Self::InvalidArgs => "INVALID_ARGS",
            Self::NotificationNotFound => "NOTIFICATION_NOT_FOUND",
            Self::SnapshotNotFound => "SNAPSHOT_NOT_FOUND",
            Self::PolicyDenied => "POLICY_DENIED",
            Self::AppUnresponsive => "APP_UNRESPONSIVE",
            Self::Internal => "INTERNAL",
        }
    }
}
