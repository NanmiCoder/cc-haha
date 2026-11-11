use std::sync::atomic::{AtomicUsize, Ordering};

use agent_desktop_core::{
    AdapterError, AppInfo, CommandContext, Deadline, InteractionLease, PermissionReport, ProcessId,
    SignalBaseline, SignalCompleteness, SignalFilter, WindowInfo, WindowState,
};
use serde_json::json;

use crate::{cli::Commands, cli_args::batch::BatchArgs};

struct SeenSetBatchAdapter {
    calls: AtomicUsize,
}

impl agent_desktop_core::ObservationOps for SeenSetBatchAdapter {
    fn list_apps(&self, _deadline: Deadline) -> Result<Vec<AppInfo>, AdapterError> {
        Ok(vec![AppInfo {
            name: "Fixture".into(),
            pid: ProcessId::new(42),
            bundle_id: Some("com.example.fixture".into()),
            process_instance: Some("fixture-42".into()),
            presentation: None,
        }])
    }
}

impl agent_desktop_core::ActionOps for SeenSetBatchAdapter {}

impl agent_desktop_core::InputOps for SeenSetBatchAdapter {
    fn clear_clipboard(
        &self,
        _lease: &InteractionLease,
    ) -> Result<agent_desktop_core::OperationReport, AdapterError> {
        Ok(agent_desktop_core::OperationReport::delivered_unverified(
            "test",
            agent_desktop_core::OperationTarget::Clipboard,
        ))
    }
}

impl agent_desktop_core::SystemOps for SeenSetBatchAdapter {
    fn acquire_interaction_lease(
        &self,
        deadline: Deadline,
    ) -> Result<InteractionLease, AdapterError> {
        InteractionLease::guarded(deadline, ())
    }

    fn capture_signal_baseline(
        &self,
        _filter: &SignalFilter,
        _deadline: Deadline,
    ) -> Result<SignalBaseline, AdapterError> {
        let call = self.calls.fetch_add(1, Ordering::SeqCst);
        let windows = if call == 1 {
            vec![WindowInfo {
                id: "w-seen".into(),
                title: "Seen".into(),
                app: "Fixture".into(),
                pid: ProcessId::new(42),
                process_instance: Some("fixture-42".into()),
                bounds: None,
                state: WindowState {
                    is_focused: true,
                    ..WindowState::default()
                },
            }]
        } else {
            Vec::new()
        };
        Ok(SignalBaseline {
            windows,
            apps: vec![AppInfo {
                name: "Fixture".into(),
                pid: ProcessId::new(42),
                bundle_id: Some("com.example.fixture".into()),
                process_instance: Some("fixture-42".into()),
                presentation: None,
            }],
            surfaces: Vec::new(),
            completeness: SignalCompleteness::complete(),
        })
    }
}

/// Regression guard for the batch pre-seed defect: `execution.rs` captures a
/// `SignalBaseline` before entry N runs whenever entry N+1 is a `wait`, and
/// hands it to the wait as its `seeded_baseline`. Before the seen-set fix,
/// `wait_for_event` diffed every later poll against that fixed pre-action
/// capture, so a window that both opened and closed after the pre-seed
/// (call index 0, empty) was invisible to both the capture that saw it
/// (index 1) and the one that didn't (index 2) once compared against the
/// original empty seed — the wait ran its full timeout with an empty
/// pre-seed baseline instead of reporting the close. `src/batch/execution.rs`
/// is unmodified; this exercises the fix entirely through `wait_for_event`'s
/// seen-set.
#[test]
fn batch_pre_seed_baseline_lets_seen_set_report_a_window_close_not_a_timeout() {
    let commands = json!([
        {"command": "clipboard-clear", "args": {}},
        {
            "command": "wait",
            "args": {"event": "window-closed", "app": "Fixture", "timeout": 5000}
        }
    ]);
    let args = BatchArgs {
        commands_json: commands.to_string(),
        stop_on_error: true,
        timeout_ms: 60_000,
    };
    let adapter = SeenSetBatchAdapter {
        calls: AtomicUsize::new(0),
    };

    let value = crate::dispatch::dispatch(
        Commands::Batch(args),
        &adapter,
        &PermissionReport::default(),
        &CommandContext::default(),
    )
    .unwrap();

    assert_eq!(
        value["results"][0]["ok"], true,
        "the first batch entry must succeed"
    );
    assert_eq!(
        value["results"][1]["ok"], true,
        "the wait entry must succeed"
    );
    assert_eq!(
        value["results"][1]["data"]["event"]["kind"],
        "window_closed"
    );
    assert_eq!(value["results"][1]["data"]["event"]["window_id"], "w-seen");
}
