use agent_desktop_core::{AdapterError, AppError, DeliverySemantics, ErrorCode};

/// Settles the delivery of an error that carries none. A refusal for invalid
/// arguments never reached the application, and a read-only command sends
/// nothing, so a retry of either repeats no effect. Every other unknown stays
/// unknown: a mutation that timed out may already have landed. An error of a
/// read-only command that has no disposition slot (`Io`, `Json`, `Internal`)
/// becomes an adapter error that keeps its code and message.
pub(super) fn settle_unknown_delivery(error: AppError, read_only: bool) -> AppError {
    match error {
        AppError::Adapter(source) => settle(source, read_only).into(),
        other if read_only => settle(adapter_form(other), true).into(),
        other => other,
    }
}

fn settle(source: AdapterError, read_only: bool) -> AdapterError {
    let sent_nothing = read_only || source.code == ErrorCode::InvalidArgs;
    if source.disposition == DeliverySemantics::unknown() && sent_nothing {
        source.with_disposition(DeliverySemantics::not_delivered())
    } else {
        source
    }
}

fn adapter_form(error: AppError) -> AdapterError {
    let message = error.to_string();
    match error {
        AppError::Adapter(source) => source,
        AppError::Io(source) if source.kind() == std::io::ErrorKind::PermissionDenied => {
            AdapterError::new(ErrorCode::PermDenied, message)
        }
        AppError::Io(_) | AppError::Json(_) | AppError::Internal(_) => {
            AdapterError::new(ErrorCode::Internal, message)
        }
    }
}
