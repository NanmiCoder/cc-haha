use agent_desktop_core::{AdapterError, DeliverySemantics, ErrorCode};
use serde_json::{Value, json};

use crate::tree::properties::absence::{UNKNOWN_OBJECT, failure, failure_of_name};
use crate::tree::properties::failure::Failure;

const NOT_SUPPORTED: &str = "org.freedesktop.DBus.Error.NotSupported";
const PROPERTY_READ_ONLY: &str = "org.freedesktop.DBus.Error.PropertyReadOnly";
const UNKNOWN_PROPERTY: &str = "org.freedesktop.DBus.Error.UnknownProperty";
const INVALID_ARGS: &str = "org.freedesktop.DBus.Error.InvalidArgs";
const ACCESS_DENIED: &str = "org.freedesktop.DBus.Error.AccessDenied";
const NO_REPLY: &str = "org.freedesktop.DBus.Error.NoReply";
const TIMEOUT: &str = "org.freedesktop.DBus.Error.Timeout";
const TIMED_OUT: &str = "org.freedesktop.DBus.Error.TimedOut";
const NO_SUCH_ACTION: &str = "org.gtk.GDBus.UnmappedGError.Quark._g_2dio_2derror_2dquark.Code13";
const RECIPIENT_LEFT: &str = "recipient disconnected";

const REFRESH: &str = "Run 'snapshot' to refresh, then retry with the updated ref.";
const READ_FIRST: &str =
    "Read the element to see whether the write landed before any retry; do not repeat it blind.";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WriteKind {
    DoAction,
    SelectChild,
    ClearSelection,
    ScrollTo,
    GrabFocus,
    InsertText,
    DeleteText,
    SetTextContents,
    SetProperty,
}

impl WriteKind {
    pub(crate) fn returns_flag(self) -> bool {
        !matches!(self, Self::SetProperty)
    }

    pub(crate) fn carries_text(self) -> bool {
        matches!(self, Self::InsertText | Self::SetTextContents)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Corroboration {
    Alive,
    Dead,
    TimedOut,
    NotRead,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WriteReply {
    Done,
    Absent,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Fault {
    AppGone,
    ObjectUnknown,
    InterfaceMissing,
    Unsupported,
    NoSuchAction,
    InvalidArgs,
    AccessDenied,
    TimedOut,
    Uncertain,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Abort {
    Stale,
    InvalidArgs,
    Denied,
    Unconfirmed,
    TimedOut,
    Uncertain,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Verdict {
    Absent,
    Abort(Abort),
}

pub(crate) fn fault_of_name(name: &str) -> Fault {
    match failure_of_name(name) {
        Failure::AppGone => Fault::AppGone,
        Failure::Suspect if name == UNKNOWN_OBJECT => Fault::ObjectUnknown,
        Failure::Suspect => Fault::InterfaceMissing,
        Failure::TimedOut | Failure::Other => match name {
            NOT_SUPPORTED | PROPERTY_READ_ONLY | UNKNOWN_PROPERTY => Fault::Unsupported,
            NO_SUCH_ACTION => Fault::NoSuchAction,
            INVALID_ARGS => Fault::InvalidArgs,
            ACCESS_DENIED => Fault::AccessDenied,
            NO_REPLY | TIMEOUT | TIMED_OUT => Fault::TimedOut,
            _ => Fault::Uncertain,
        },
    }
}

pub(crate) fn fault_of(error: &zbus::Error) -> Fault {
    match error {
        zbus::Error::MethodError(name, Some(text), _)
            if name.as_str() == NO_REPLY && text.contains(RECIPIENT_LEFT) =>
        {
            Fault::Uncertain
        }
        zbus::Error::MethodError(name, _, _) => fault_of_name(name.as_str()),
        other => match failure(other) {
            Failure::TimedOut => Fault::TimedOut,
            _ => Fault::Uncertain,
        },
    }
}

pub(crate) fn classify_write(
    fault: Fault,
    kind: WriteKind,
    corroboration: Corroboration,
) -> Verdict {
    match fault {
        Fault::NoSuchAction if kind == WriteKind::DoAction => Verdict::Absent,
        Fault::NoSuchAction => Verdict::Abort(Abort::Uncertain),
        Fault::AppGone => Verdict::Abort(Abort::Stale),
        Fault::Unsupported => Verdict::Absent,
        Fault::InvalidArgs => Verdict::Abort(Abort::InvalidArgs),
        Fault::AccessDenied => Verdict::Abort(Abort::Denied),
        Fault::TimedOut => Verdict::Abort(Abort::TimedOut),
        Fault::Uncertain => Verdict::Abort(Abort::Uncertain),
        Fault::ObjectUnknown | Fault::InterfaceMissing => match corroboration {
            Corroboration::Alive => Verdict::Absent,
            Corroboration::Dead => Verdict::Abort(Abort::Stale),
            Corroboration::TimedOut | Corroboration::NotRead => Verdict::Abort(Abort::Unconfirmed),
        },
    }
}

fn detail_of(source: Option<&zbus::Error>, kind: WriteKind) -> Option<String> {
    match source? {
        zbus::Error::MethodError(name, _, _) if kind.carries_text() => {
            Some(name.as_str().to_owned())
        }
        other => Some(other.to_string()),
    }
}

pub(crate) fn abort_error(
    abort: Abort,
    kind: WriteKind,
    source: Option<&zbus::Error>,
) -> AdapterError {
    let (code, message, suggestion, disposition) = match abort {
        Abort::Stale => (
            ErrorCode::StaleRef,
            "The target no longer exists",
            REFRESH,
            DeliverySemantics::not_delivered(),
        ),
        Abort::InvalidArgs => (
            ErrorCode::InvalidArgs,
            "The application rejected the index or the value",
            "Check the argument against the element's role, then retry.",
            DeliverySemantics::not_delivered(),
        ),
        Abort::Denied => (
            ErrorCode::PermDenied,
            "The application refused the write",
            "The application does not let accessibility clients change this element.",
            DeliverySemantics::not_delivered(),
        ),
        Abort::Unconfirmed => (
            ErrorCode::ActionFailed,
            "The write was refused and the target could not be confirmed present",
            REFRESH,
            DeliverySemantics::not_delivered(),
        ),
        Abort::TimedOut => (
            ErrorCode::Timeout,
            "The application did not answer after the write was sent",
            READ_FIRST,
            DeliverySemantics::uncertain(),
        ),
        Abort::Uncertain => (
            ErrorCode::ActionFailed,
            "The write ended in an error that does not show whether it landed",
            READ_FIRST,
            DeliverySemantics::uncertain(),
        ),
    };
    let error = AdapterError::new(code, message)
        .with_suggestion(suggestion)
        .with_disposition(disposition);
    match detail_of(source, kind) {
        Some(detail) => error.with_platform_detail(detail),
        None => error,
    }
}

pub(crate) fn deadline_error(error: AdapterError, sent: bool) -> AdapterError {
    if sent {
        error
            .with_suggestion(READ_FIRST)
            .with_disposition(DeliverySemantics::uncertain())
    } else {
        error.with_disposition(DeliverySemantics::not_delivered())
    }
}

pub(crate) fn with_value_chars(error: AdapterError, chars: usize) -> AdapterError {
    let mut details = error.details.clone().unwrap_or_else(|| json!({}));
    if let Value::Object(map) = &mut details {
        map.insert("value_chars".to_owned(), json!(chars));
    }
    error.with_details(details)
}

#[cfg(test)]
#[path = "mutation_tests.rs"]
mod tests;
