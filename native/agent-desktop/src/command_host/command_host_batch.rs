use agent_desktop_core::{AppError, Deadline, context::CommandContext};
use clap::Parser;
use serde_json::{Value, json};

pub(crate) fn forward_batch_item(
    source: &Value,
    context: &CommandContext,
    deadline: Deadline,
) -> Result<Value, AppError> {
    let original =
        crate::Cli::try_parse().map_err(|error| AppError::invalid_input(error.to_string()))?;
    let mut args = Vec::new();
    if let Some(session) = context.session_id() {
        args.extend(["--session".into(), session.into()]);
    }
    if let Some(agent) = context.agent_id() {
        args.extend(["--agent-id".into(), agent.into()]);
    }
    if context.is_headed() {
        args.push("--headed".into());
    }
    if let Some(trace) = original.trace {
        args.extend([
            "--trace".into(),
            trace
                .to_str()
                .ok_or_else(|| AppError::invalid_input("Trace path must be UTF-8"))?
                .into(),
        ]);
    }
    if original.trace_strict {
        args.push("--trace-strict".into());
    }
    if deadline.is_expired() {
        return Err(deadline.timeout_error().into());
    }
    args.extend([
        "batch".into(),
        json!([source]).to_string(),
        "--timeout-ms".into(),
        deadline.remaining_ms().to_string(),
    ]);
    let mut cli =
        crate::Cli::try_parse_from(std::iter::once("agent-desktop".to_owned()).chain(args.clone()))
            .map_err(|error| AppError::invalid_input(error.to_string()))?;
    let command = cli
        .command
        .take()
        .ok_or_else(|| AppError::Internal("Constructed batch command is missing".into()))?;
    let baseline = context.event_baseline().cloned().transpose()?;
    let response = super::client::forward_args(&cli, &command, args, baseline)?;
    if response["ok"] == true {
        response["data"]["results"]
            .as_array()
            .and_then(|entries| entries.first())
            .cloned()
            .ok_or_else(|| AppError::invalid_input("Command host batch reply has no entry"))
    } else {
        let mut entry = response;
        entry["command"] = source["command"].clone();
        entry["execution"] = json!("completed");
        Ok(entry)
    }
}
