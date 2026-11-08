use agent_desktop_core::{
    AdapterError, AppError, DeliverySemantics, ErrorCode, PermissionReport,
    commands::batch::BatchCommand, context::CommandContext,
};
use serde_json::{Value, json};

use crate::cli::Commands;

pub(super) const MAX_BATCH_JSON_BYTES: usize = 1024 * 1024;
pub(super) const MAX_BATCH_ENTRIES: usize = 64;

pub(super) struct PreparedCommand {
    pub name: String,
    pub command: Commands,
    pub context: CommandContext,
    #[cfg(target_os = "macos")]
    pub source: Value,
}

pub(super) fn prepare(
    input: &str,
    permission_report: &PermissionReport,
    context: &CommandContext,
) -> Result<Vec<PreparedCommand>, AppError> {
    if input.len() > MAX_BATCH_JSON_BYTES {
        return Err(limit_error(
            "Batch JSON exceeds the input limit",
            json!({ "actual_bytes": input.len(), "max_bytes": MAX_BATCH_JSON_BYTES }),
        ));
    }
    let items = agent_desktop_core::commands::batch::parse_commands(input)?;
    if items.len() > MAX_BATCH_ENTRIES {
        return Err(limit_error(
            "Batch contains too many entries",
            json!({ "actual_entries": items.len(), "max_entries": MAX_BATCH_ENTRIES }),
        ));
    }

    let parsed = items
        .into_iter()
        .enumerate()
        .map(|(index, item)| parse_one(index, item, permission_report))
        .collect::<Result<Vec<_>, _>>()?;
    parsed
        .into_iter()
        .map(|(index, name, command, session, _source)| {
            let item_context = context
                .for_batch_item(session)
                .map_err(|error| located_error(index, &name, error))?;
            crate::command_policy::preflight_context(&command, &item_context)
                .map_err(|error| located_error(index, &name, error))?;
            Ok(PreparedCommand {
                name,
                command,
                context: item_context,
                #[cfg(target_os = "macos")]
                source: _source,
            })
        })
        .collect()
}

fn parse_one(
    index: usize,
    item: BatchCommand,
    permission_report: &PermissionReport,
) -> Result<(usize, String, Commands, Option<String>, Value), AppError> {
    let source = json!({"command": item.command, "args": item.args});
    let name = item.command.clone();
    let session = item.session.clone();
    if let Some(session) = session.as_deref() {
        agent_desktop_core::context::validate_session_id(session)
            .map_err(|error| located_error(index, &name, error))?;
    }
    let command = super::parse_command(item).map_err(|error| located_error(index, &name, error))?;
    crate::command_policy::preflight(&command, permission_report)
        .map_err(|error| located_error(index, &name, error))?;
    Ok((index, name, command, session, source))
}

fn located_error(index: usize, command: &str, error: AppError) -> AppError {
    match error {
        AppError::Adapter(mut source) => {
            let cause_details = source.details.take();
            let mut details = json!({ "batch_index": index, "batch_command": command });
            if let Some(cause_details) = cause_details {
                details["cause_details"] = cause_details;
            }
            source.message = format!(
                "Batch entry {index} ('{command}') failed validation: {}",
                source.message
            );
            source.details = Some(details);
            source.disposition = DeliverySemantics::not_delivered();
            source.into()
        }
        other => AdapterError::new(ErrorCode::Internal, other.to_string())
            .with_details(json!({ "batch_index": index, "batch_command": command }))
            .with_disposition(DeliverySemantics::not_delivered())
            .into(),
    }
}

fn limit_error(message: &str, details: Value) -> AppError {
    AdapterError::new(ErrorCode::InvalidArgs, message)
        .with_suggestion("Split the batch or narrow commands that return large payloads")
        .with_details(details)
        .with_disposition(DeliverySemantics::not_delivered())
        .into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_pinned_namespace_rejects_foreign_item_sessions_before_dispatch() {
        let context = CommandContext::default().with_pinned_session_namespace();
        match prepare(
            r#"[{"command":"version","session":"other"}]"#,
            &PermissionReport::default(),
            &context,
        ) {
            Ok(_) => panic!("a foreign item session must be rejected"),
            Err(error) => assert!(
                error
                    .to_string()
                    .contains("cannot switch snapshot namespaces")
            ),
        }
        let prepared = prepare(
            r#"[{"command":"version"}]"#,
            &PermissionReport::default(),
            &context,
        )
        .unwrap();
        assert_eq!(prepared.len(), 1);
        assert_eq!(prepared[0].context.session_id(), None);
    }
}
