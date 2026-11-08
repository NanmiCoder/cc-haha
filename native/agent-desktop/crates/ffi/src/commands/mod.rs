pub(crate) mod envelope_out;
pub(crate) mod execute_by_ref;
pub(crate) mod execute_by_ref_timeout;
pub(crate) mod snapshot;
pub(crate) mod status;
pub(crate) mod timeout;
pub(crate) mod trace_export;
pub(crate) mod trace_show;
pub(crate) mod version;
pub(crate) mod wait;

use agent_desktop_core::{AdapterError, AppError, ErrorCode};

/// Converts a core `AppError` into an `AdapterError` for use with
/// `set_last_error`. `AppError::Adapter` is already an `AdapterError`; a
/// permission-denied io error keeps `ErrorCode::PermDenied`, the code the
/// JSON envelope reports for it, and every other variant wraps its payload as
/// `ErrorCode::Internal`.
pub(crate) fn app_error_to_adapter(err: AppError) -> AdapterError {
    match err {
        AppError::Adapter(e) => e,
        AppError::Io(e) if e.kind() == std::io::ErrorKind::PermissionDenied => {
            AdapterError::new(ErrorCode::PermDenied, e.to_string())
        }
        AppError::Io(e) => AdapterError::new(ErrorCode::Internal, e.to_string()),
        AppError::Json(e) => AdapterError::new(ErrorCode::Internal, e.to_string()),
        AppError::Internal(msg) => AdapterError::new(ErrorCode::Internal, msg),
    }
}

macro_rules! command_scope {
    ($context:expr, $name:expr) => {{
        match $context.command_scope($name) {
            Ok(scope) => scope,
            Err(error) => {
                let error = $crate::commands::app_error_to_adapter(error);
                $crate::error::set_last_error(&error);
                return $crate::error::last_error_code();
            }
        }
    }};
}

macro_rules! mutating_command_scope {
    ($context:expr, $name:expr) => {{
        match $context.mutating_command_scope($name) {
            Ok(scope) => scope,
            Err(error) => {
                let error = $crate::commands::app_error_to_adapter(error);
                $crate::error::set_last_error(&error);
                return $crate::error::last_error_code();
            }
        }
    }};
}

macro_rules! complete_scope {
    ($scope:expr, $result:expr) => {{
        if let Err(error) = $scope.complete($result) {
            let error = $crate::commands::app_error_to_adapter(error);
            $crate::error::set_last_error(&error);
            return $crate::error::last_error_code();
        }
    }};
}

pub(crate) use command_scope;
pub(crate) use complete_scope;
pub(crate) use mutating_command_scope;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adapter_variant_passes_through_with_original_code_and_message() {
        let ae = AdapterError::stale_ref("@e42");
        let original_code = ae.code.clone();
        let original_msg = ae.message.clone();
        let result = app_error_to_adapter(AppError::Adapter(ae));
        assert_eq!(result.code, original_code);
        assert_eq!(result.message, original_msg);
    }

    #[test]
    fn io_error_collapses_to_internal_and_embeds_os_message() {
        let io_err = std::io::Error::new(std::io::ErrorKind::NotFound, "file gone");
        let result = app_error_to_adapter(AppError::Io(io_err));
        assert_eq!(result.code, ErrorCode::Internal);
        assert!(
            result.message.contains("file gone"),
            "IO message must be forwarded; got: {:?}",
            result.message
        );
    }

    #[test]
    fn permission_denied_io_error_keeps_the_code_the_envelope_reports() {
        let error = AppError::Io(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "denied",
        ));
        let envelope_code = error.code().to_owned();
        let result = app_error_to_adapter(error);
        assert_eq!(result.code, ErrorCode::PermDenied);
        assert_eq!(result.code.as_str(), envelope_code);
    }

    #[test]
    fn json_error_collapses_to_internal_forwarding_the_parse_message() {
        let json_err = serde_json::from_str::<serde_json::Value>("not json").unwrap_err();
        let parse_message = json_err.to_string();
        let result = app_error_to_adapter(AppError::Json(json_err));
        assert_eq!(result.code, ErrorCode::Internal);
        assert_eq!(result.message, parse_message);
    }

    #[test]
    fn internal_string_collapses_to_internal_preserving_exact_message() {
        let result = app_error_to_adapter(AppError::Internal("unexpected state".into()));
        assert_eq!(result.code, ErrorCode::Internal);
        assert_eq!(result.message, "unexpected state");
    }
}
