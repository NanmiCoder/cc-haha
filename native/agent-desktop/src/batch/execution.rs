use agent_desktop_core::{
    AdapterError, AppError, Deadline, DeliverySemantics, ErrorCode, PermissionReport,
    PlatformAdapter, SignalBaseline, SignalFilter, context::CommandContext,
};
use serde_json::{Value, json};

use crate::{cli::Commands, cli_args::batch::BatchArgs};

use super::{
    bounded_json::serialized_size,
    preparation::{MAX_BATCH_ENTRIES, MAX_BATCH_JSON_BYTES, PreparedCommand, prepare},
    result_entry::{MAX_BATCH_OUTPUT_BYTES, not_started_entry},
};

pub(super) fn execute(
    args: BatchArgs,
    adapter: &dyn PlatformAdapter,
    permission_report: &PermissionReport,
    context: &CommandContext,
) -> Result<Value, AppError> {
    let deadline = Deadline::after(args.timeout_ms)
        .map_err(|error| error.with_disposition(DeliverySemantics::not_delivered()))?;
    let batch_context = context.clone().with_inherited_deadline(deadline);
    let mut commands = prepare(&args.commands_json, permission_report, &batch_context)?;
    let total = commands.len();
    let mut results = Vec::with_capacity(total);
    let mut results_bytes = 0;
    let mut completed = 0;
    let mut pending_baseline: Option<Result<SignalBaseline, AdapterError>> =
        context.event_baseline().cloned();
    let mut stopped = None;

    for index in 0..total {
        if deadline.is_expired() {
            let error = batch_timeout(index, &commands[index].name, args.timeout_ms);
            push_small_entry(
                &mut results,
                &mut results_bytes,
                not_started_entry(index, &commands[index].name, "deadline", error),
            );
            stopped = Some(json!({ "reason": "deadline", "index": index }));
            break;
        }

        let current_baseline = pending_baseline.take();

        if let Some(ended_session) = session_ended_for(&commands[index]) {
            let error = batch_session_ended(index, &commands[index].name, &ended_session);
            push_small_entry(
                &mut results,
                &mut results_bytes,
                not_started_entry(index, &commands[index].name, "session_ended", error),
            );
            if args.stop_on_error {
                stopped = Some(json!({ "reason": "stop_on_error", "index": index }));
                break;
            }
            continue;
        }

        pending_baseline = match commands.get(index + 1).and_then(event_filter) {
            Some(filter) => match adapter.capture_signal_baseline(&filter, deadline) {
                Ok(baseline) => Some(Ok(baseline)),
                Err(error) => {
                    let wait_index = index + 1;
                    let wait_command = &commands[wait_index].name;
                    let error = baseline_error(
                        index,
                        &commands[index].name,
                        wait_index,
                        wait_command,
                        error,
                    );
                    push_small_entry(
                        &mut results,
                        &mut results_bytes,
                        not_started_entry(
                            index,
                            &commands[index].name,
                            "pre_action_baseline_failed",
                            error,
                        ),
                    );
                    stopped = Some(json!({
                        "reason": "pre_action_baseline_failed",
                        "blocked_index": index,
                        "blocked_command": commands[index].name,
                        "wait_index": wait_index,
                        "wait_command": wait_command,
                    }));
                    break;
                }
            },
            None => None,
        };

        let item_context = commands[index]
            .context
            .clone()
            .with_inherited_deadline(deadline)
            .with_event_baseline(current_baseline);
        let command = std::mem::replace(&mut commands[index].command, Commands::Version);
        #[cfg(target_os = "macos")]
        let forwarded = if !cfg!(test)
            && !context.session_namespace_is_pinned()
            && !command.needs_caller_process()
        {
            Some(crate::command_host::forward_batch_item(
                &commands[index].source,
                &item_context,
                deadline,
            ))
        } else {
            None
        };
        #[cfg(not(target_os = "macos"))]
        let forwarded: Option<Result<Value, AppError>> = None;
        let entry = match forwarded {
            Some(Ok(mut entry)) => {
                entry["index"] = json!(index);
                entry
            }
            result => super::result_entry::completed_entry(
                index,
                &commands[index].name,
                match result {
                    Some(Err(error)) => Err(error),
                    _ => crate::dispatch::dispatch(
                        command,
                        adapter,
                        permission_report,
                        &item_context,
                    ),
                },
            ),
        };
        let failed = entry["ok"] != true;
        let (entry, oversized) = super::result_entry::bounded_completed_entry(
            index,
            &commands[index].name,
            entry,
            results_bytes,
        );
        completed += usize::from(entry["execution"] == "completed");
        push_small_entry(&mut results, &mut results_bytes, entry);

        if oversized {
            stopped = Some(json!({ "reason": "output_limit", "index": index }));
            break;
        }
        if failed && args.stop_on_error {
            stopped = Some(json!({ "reason": "stop_on_error", "index": index }));
            break;
        }
        if deadline.is_expired() && index + 1 < total {
            stopped = Some(json!({ "reason": "deadline", "after_index": index }));
            break;
        }
    }

    let mut body = json!({
        "results": results,
        "semantics": {
            "atomic": false,
            "order": "sequential",
            "batch_retries": false,
            "command_retry_contracts": "preserved",
            "successful_action_disposition": "data.disposition",
            "error_disposition": "error.disposition",
        },
        "total_entries": total,
        "completed_entries": completed,
        "not_started_entries": total.saturating_sub(completed),
        "timeout_ms": args.timeout_ms,
        "elapsed_ms": deadline.elapsed().as_millis(),
        "limits": {
            "max_entries": MAX_BATCH_ENTRIES,
            "max_input_bytes": MAX_BATCH_JSON_BYTES,
            "max_output_bytes": MAX_BATCH_OUTPUT_BYTES,
        }
    });
    if let Some(stopped) = stopped {
        body["stopped"] = stopped;
    }
    if serialized_size(&body) > MAX_BATCH_OUTPUT_BYTES {
        let disposition = if completed == 0 {
            DeliverySemantics::not_delivered()
        } else {
            DeliverySemantics::uncertain()
        };
        return Err(AdapterError::new(
            ErrorCode::Internal,
            "Batch response exceeded its output contract after final serialization",
        )
        .with_details(json!({
            "kind": "batch_output_limit",
            "completed_entries": completed,
            "max_output_bytes": MAX_BATCH_OUTPUT_BYTES,
        }))
        .with_disposition(disposition)
        .into());
    }
    Ok(body)
}

fn event_filter(command: &PreparedCommand) -> Option<SignalFilter> {
    match &command.command {
        Commands::Wait(args) if args.event.event.is_some() => Some(SignalFilter {
            app: args.app.clone(),
            process: None,
        }),
        _ => None,
    }
}

fn baseline_error(
    blocked_index: usize,
    blocked_command: &str,
    wait_index: usize,
    wait_command: &str,
    mut source: AdapterError,
) -> AppError {
    let cause_details = source.details.take();
    source.message = format!(
        "Batch entry {blocked_index} ('{blocked_command}') was not started because the baseline for following wait entry {wait_index} ('{wait_command}') failed: {}",
        source.message
    );
    let mut details = json!({
        "kind": "pre_action_baseline_failed",
        "blocked_index": blocked_index,
        "blocked_command": blocked_command,
        "wait_index": wait_index,
        "wait_command": wait_command,
    });
    if let Some(cause_details) = cause_details {
        details["cause_details"] = cause_details;
    }
    source.details = Some(details);
    source.disposition = DeliverySemantics::not_delivered();
    source.into()
}

fn session_ended_for(command: &PreparedCommand) -> Option<String> {
    let session_id = command.context.session_id()?;
    match agent_desktop_core::session::read_manifest(session_id) {
        Ok(Some(manifest)) if manifest.ended_at.is_some() => Some(session_id.to_owned()),
        _ => None,
    }
}

fn batch_session_ended(index: usize, command: &str, session_id: &str) -> AppError {
    AdapterError::new(
        ErrorCode::InvalidArgs,
        format!(
            "Batch entry {index} ('{command}') was not started because session '{session_id}' has ended"
        ),
    )
    .with_suggestion("Re-run the entry outside the ended session or start a new session")
    .with_details(json!({
        "kind": "batch_session_ended",
        "batch_index": index,
        "batch_command": command,
        "session_id": session_id,
    }))
    .with_disposition(DeliverySemantics::not_delivered())
    .into()
}

fn batch_timeout(index: usize, command: &str, timeout_ms: u64) -> AppError {
    AdapterError::timeout("Batch deadline elapsed before the entry started")
        .with_details(json!({
            "kind": "batch_deadline",
            "batch_index": index,
            "batch_command": command,
            "timeout_ms": timeout_ms,
        }))
        .with_disposition(DeliverySemantics::not_delivered())
        .into()
}

fn push_small_entry(results: &mut Vec<Value>, used: &mut usize, entry: Value) {
    *used = used.saturating_add(serialized_size(&entry).saturating_add(1));
    results.push(entry);
}

#[cfg(test)]
#[path = "execution_tests.rs"]
mod tests;
