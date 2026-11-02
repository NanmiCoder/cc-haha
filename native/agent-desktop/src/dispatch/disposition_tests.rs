use super::dispatch;
use super::disposition::settle_unknown_delivery;
use crate::cli::Cli;
use crate::cli_args::batch::BatchArgs;
use agent_desktop_core::{
    ActionOps, AdapterError, AppError, AppInfo, Deadline, DeliveryDisposition, DeliverySemantics,
    ErrorCode, InputOps, InteractionLease, ObservationOps, OperationReport, PermissionReport,
    RetryDisposition, SystemOps, WindowFilter, WindowInfo, context::CommandContext,
};
use clap::Parser;
use serde_json::{Value, json};

struct FailingAdapter(AdapterError);

impl ObservationOps for FailingAdapter {
    fn list_windows(
        &self,
        _filter: &WindowFilter,
        _deadline: Deadline,
    ) -> Result<Vec<WindowInfo>, AdapterError> {
        Err(self.0.clone())
    }

    fn list_apps(&self, _deadline: Deadline) -> Result<Vec<AppInfo>, AdapterError> {
        Err(self.0.clone())
    }
}

impl ActionOps for FailingAdapter {}

impl InputOps for FailingAdapter {
    fn clear_clipboard(&self, _lease: &InteractionLease) -> Result<OperationReport, AdapterError> {
        Err(self.0.clone())
    }
}

impl SystemOps for FailingAdapter {
    fn acquire_interaction_lease(
        &self,
        deadline: Deadline,
    ) -> Result<InteractionLease, AdapterError> {
        InteractionLease::guarded(deadline, ())
    }
}

fn failure_of(adapter_failure: AdapterError, arguments: &[&str]) -> AdapterError {
    let mut argv = vec!["agent-desktop"];
    argv.extend_from_slice(arguments);
    let command = Cli::try_parse_from(argv)
        .expect("command parses")
        .command
        .expect("subcommand is present");
    match dispatch(
        command,
        &FailingAdapter(adapter_failure),
        &PermissionReport::default(),
        &CommandContext::default(),
    ) {
        Err(AppError::Adapter(error)) => error,
        other => panic!("expected an adapter error, got {other:?}"),
    }
}

#[test]
fn a_refused_argument_is_not_delivered_even_for_a_mutation() {
    let refused_by_the_adapter = failure_of(
        AdapterError::new(ErrorCode::InvalidArgs, "payload rejected"),
        &["clipboard-clear"],
    );
    let refused_by_core = failure_of(
        AdapterError::internal("unused"),
        &["resize-window", "--width=-100", "--height", "300"],
    );

    for error in [refused_by_the_adapter, refused_by_core] {
        assert_eq!(error.code, ErrorCode::InvalidArgs);
        assert_eq!(
            error.disposition.delivery(),
            DeliveryDisposition::NotDelivered
        );
        assert_eq!(error.disposition.retry(), RetryDisposition::Safe);
    }
}

#[test]
fn a_timeout_of_a_read_only_command_is_not_delivered() {
    for arguments in [["list-windows"], ["list-apps"]] {
        let error = failure_of(AdapterError::timeout("inventory timed out"), &arguments);

        assert_eq!(error.code, ErrorCode::Timeout, "{arguments:?}");
        assert_eq!(
            error.disposition.delivery(),
            DeliveryDisposition::NotDelivered,
            "{arguments:?}"
        );
        assert_eq!(error.disposition.retry(), RetryDisposition::Safe);
    }
}

#[test]
fn a_timeout_of_a_mutation_keeps_its_unknown_delivery() {
    let error = failure_of(
        AdapterError::timeout("clipboard did not settle"),
        &["clipboard-clear"],
    );

    assert_eq!(error.code, ErrorCode::Timeout);
    assert_eq!(error.disposition, DeliverySemantics::unknown());
}

#[test]
fn evidence_the_error_already_carries_is_never_replaced() {
    let uncertain = AdapterError::new(ErrorCode::InvalidArgs, "payload rejected after the write")
        .with_disposition(DeliverySemantics::uncertain());
    let delivered = AdapterError::timeout("inventory timed out")
        .with_disposition(DeliverySemantics::delivered_unverified());

    assert_eq!(
        failure_of(uncertain, &["clipboard-clear"]).disposition,
        DeliverySemantics::uncertain()
    );
    assert_eq!(
        failure_of(delivered, &["list-windows"]).disposition,
        DeliverySemantics::delivered_unverified()
    );
}

#[test]
fn a_read_only_failure_that_is_not_an_adapter_error_keeps_its_code_and_message() {
    let failures = [
        AppError::Io(std::io::Error::from(std::io::ErrorKind::PermissionDenied)),
        AppError::Io(std::io::Error::other("disk full")),
        AppError::Json(serde_json::from_str::<Value>("{").unwrap_err()),
        AppError::Internal("trace writer lock poisoned".into()),
    ];
    for failure in failures {
        let code = failure.code().to_owned();
        let message = failure.to_string();

        let AppError::Adapter(settled) = settle_unknown_delivery(failure, true) else {
            panic!("a read-only failure must carry a delivery verdict");
        };

        assert_eq!(settled.code.as_str(), code);
        assert_eq!(settled.to_string(), message);
        assert_eq!(settled.disposition, DeliverySemantics::not_delivered());
    }
}

#[test]
fn a_mutations_failure_that_is_not_an_adapter_error_is_left_as_it_came() {
    let settled = settle_unknown_delivery(AppError::Io(std::io::Error::other("disk full")), false);

    assert!(matches!(settled, AppError::Io(_)));
}

#[test]
fn batch_entries_settle_their_failures_by_their_own_command() {
    let commands = json!([
        {"command": "list-windows", "args": {}},
        {"command": "clipboard-clear", "args": {}}
    ]);

    let output = crate::batch::execute(
        BatchArgs {
            commands_json: commands.to_string(),
            stop_on_error: false,
            timeout_ms: 60_000,
        },
        &FailingAdapter(AdapterError::timeout("stalled")),
        &PermissionReport::default(),
        &CommandContext::default(),
    )
    .expect("a batch reports the failure of each entry");

    let delivery =
        |index: usize| output["results"][index]["error"]["disposition"]["delivery"].clone();
    assert_eq!(delivery(0), "not_delivered");
    assert_eq!(delivery(1), "unknown");
}
