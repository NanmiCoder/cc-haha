use super::*;

#[test]
fn show_and_export_hide_only_their_own_open_trace_command() {
    let _guard = HomeGuard::new();
    let manifest = start_session(StartSessionOptions {
        trace: SessionTraceMode::On,
        ..Default::default()
    })
    .unwrap();
    let trace_dir = crate::refs::refs_store::RefStore::for_session(Some(&manifest.id))
        .unwrap()
        .trace_dir();
    fs::create_dir_all(&trace_dir).unwrap();
    let pid = std::process::id();
    let old_process_orphan = format!(
        "{{\"event\":\"command.start\",\"command\":\"trace\",\"writer_pid\":{pid},\"writer_proc_start_ms\":1,\"ts_ms\":1,\"seq\":1}}\n"
    );
    fs::write(trace_dir.join(format!("{pid}-1.jsonl")), old_process_orphan).unwrap();

    let context = CommandContext::new(Some(manifest.id), None, false).unwrap();
    context
        .trace("command.start", json!({ "command": "click" }))
        .unwrap();
    let show_scope = context.command_scope("trace").unwrap();
    let show = execute(
        TraceAction::Show {
            limit: 0,
            event: None,
        },
        &context,
    )
    .unwrap();
    let show_warnings = show["warnings"].as_array().expect("orphan warnings");
    assert_eq!(show_warnings.len(), 2);
    let show_messages: Vec<_> = show_warnings
        .iter()
        .filter_map(|warning| warning["message"].as_str())
        .collect();
    assert!(
        show_messages
            .iter()
            .any(|message| message.contains("click"))
    );
    assert!(
        show_messages
            .iter()
            .any(|message| message.contains(&format!("for 'trace' in segment {pid}-1")))
    );
    show_scope.complete(&Ok(show)).unwrap();

    let export_scope = context.command_scope("trace").unwrap();
    let export = execute(
        TraceAction::Export {
            limit: 0,
            out: None,
        },
        &context,
    )
    .unwrap();
    let export_warnings = export["warnings"].as_array().expect("orphan warnings");
    assert_eq!(export_warnings.len(), 2);
    let export_messages: Vec<_> = export_warnings
        .iter()
        .filter_map(|warning| warning["message"].as_str())
        .collect();
    assert!(
        export_messages
            .iter()
            .any(|message| message.contains("click"))
    );
    assert!(
        export_messages
            .iter()
            .any(|message| message.contains(&format!("for 'trace' in segment {pid}-1")))
    );
    export_scope.complete(&Ok(export)).unwrap();
}
