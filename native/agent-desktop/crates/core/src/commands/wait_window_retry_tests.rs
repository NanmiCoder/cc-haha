use super::test_support::wait_args;
use super::*;
use crate::adapter::{ActionOps, InputOps, ObservationOps, SystemOps};
use crate::{AdapterError, ErrorCode, WindowInfo, adapter::WindowFilter};

struct MissingAppAdapter(AdapterError);

impl ObservationOps for MissingAppAdapter {
    fn list_windows(
        &self,
        _filter: &WindowFilter,
        _deadline: crate::Deadline,
    ) -> Result<Vec<WindowInfo>, AdapterError> {
        Err(self.0.clone())
    }
}

impl ActionOps for MissingAppAdapter {}

impl InputOps for MissingAppAdapter {}

impl SystemOps for MissingAppAdapter {}

#[test]
fn window_wait_keeps_polling_an_application_that_has_not_registered_yet() {
    let err = execute(
        WaitArgs {
            mode: WaitModeArgs {
                window: Some("Document".into()),
                ..wait_args().mode
            },
            timeout_ms: 40,
            ..wait_args()
        },
        &MissingAppAdapter(AdapterError::new(
            ErrorCode::AppNotFound,
            "No running application matches 'launching'",
        )),
        &CommandContext::default(),
    )
    .unwrap_err();

    let AppError::Adapter(adapter_err) = err else {
        panic!("an absent application must end in the wait timeout");
    };
    assert_eq!(adapter_err.code, ErrorCode::Timeout);
    let details = adapter_err.details.expect("timeout details");
    assert_eq!(details["kind"], "wait_timeout");
    assert_eq!(details["last_error"]["code"], "APP_NOT_FOUND");
}

#[test]
fn window_wait_returns_explicitly_terminal_absence_without_normalizing_it() {
    for code in [ErrorCode::AppNotFound, ErrorCode::WindowNotFound] {
        let original = AdapterError::new(code, "The target cannot appear")
            .with_details(json!({ "retryable": false }))
            .with_disposition(crate::DeliverySemantics::not_delivered());
        let err = execute(
            WaitArgs {
                mode: WaitModeArgs {
                    window: Some("Document".into()),
                    ..wait_args().mode
                },
                timeout_ms: 40,
                ..wait_args()
            },
            &MissingAppAdapter(original.clone()),
            &CommandContext::default(),
        )
        .unwrap_err();
        let AppError::Adapter(err) = err else {
            panic!("the terminal adapter error must be preserved");
        };
        assert_eq!(err.code, original.code);
        assert_eq!(err.message, original.message);
        assert_eq!(err.details, original.details);
        assert_eq!(err.disposition, original.disposition);
    }
}
