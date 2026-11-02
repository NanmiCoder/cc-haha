use agent_desktop_core::{AdapterError, Deadline, ErrorCode};

#[test]
fn hard_ax_error_is_not_a_success_and_does_not_abort_the_strategy_list() {
    let deadline = Deadline::standard().expect("deadline");

    let failed = super::strategy_succeeded(
        Err(AdapterError::new(
            ErrorCode::ActionFailed,
            "AXDismiss failed",
        )),
        deadline,
    );
    let succeeded = super::strategy_succeeded(Ok(true), deadline);

    assert!(!failed.expect("a hard AX error falls through to the next strategy"));
    assert!(succeeded.expect("strategy result"));
}

#[test]
fn permission_denial_is_terminal_for_dismiss_strategies() {
    let result = super::strategy_succeeded(
        Err(AdapterError::permission_denied()),
        Deadline::standard().expect("deadline"),
    );

    assert_eq!(
        result.expect_err("permission denial must abort").code,
        ErrorCode::PermDenied
    );
}

#[test]
fn expired_deadline_is_terminal_for_dismiss_strategies() {
    let deadline = Deadline::after(0).expect("deadline");
    let result = super::strategy_succeeded(
        Err(AdapterError::new(
            ErrorCode::ActionFailed,
            "AXDismiss failed",
        )),
        deadline,
    );

    assert_eq!(
        result.expect_err("expired deadline must abort").code,
        ErrorCode::Timeout
    );
}
