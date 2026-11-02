//! Batch and CLI are one dispatcher, so for the same request their data
//! payloads must be identical bytes: the CLI emits `dispatch()`'s `Value` as
//! the envelope's `data`, and a batch entry embeds that same `Value` under
//! `"data"`. This pins the equality on `open-system-surface` - a command
//! whose answer an agent pipes into the next command - against a mock that
//! also records what the adapter received, so the policy the batch caller's
//! context produced is part of the parity assertion, not assumed.

use super::*;
use crate::cli_args::Surface;
use crate::test_noop_ops::NoopAdapter;
use agent_desktop_core::{
    AdapterError, Deadline, ErrorCode, InteractionLease, InteractionPolicy, PermissionReport,
    SnapshotSurface, SystemOps, WindowInfo,
};
use std::sync::Mutex;

struct SurfaceAdapter {
    opens: Mutex<Vec<(SnapshotSurface, InteractionPolicy)>>,
}

impl agent_desktop_core::ObservationOps for SurfaceAdapter {}
impl agent_desktop_core::ActionOps for SurfaceAdapter {}
impl agent_desktop_core::InputOps for SurfaceAdapter {}

impl SystemOps for SurfaceAdapter {
    fn acquire_interaction_lease(
        &self,
        deadline: Deadline,
    ) -> Result<InteractionLease, AdapterError> {
        InteractionLease::guarded(deadline, ())
    }

    fn open_system_surface(
        &self,
        surface: SnapshotSurface,
        policy: InteractionPolicy,
        _lease: &InteractionLease,
    ) -> Result<WindowInfo, AdapterError> {
        self.opens.lock().unwrap().push((surface, policy));
        Ok(WindowInfo {
            id: "w-77".into(),
            title: "Action center".into(),
            app: "ShellExperienceHost.exe".into(),
            pid: agent_desktop_core::ProcessId::new(7),
            process_instance: None,
            bounds: None,
            state: Default::default(),
        })
    }
}

#[test]
fn batch_and_cli_produce_identical_envelopes_for_the_same_open() {
    let adapter = SurfaceAdapter {
        opens: Mutex::new(Vec::new()),
    };
    let report = PermissionReport::default();
    let context = agent_desktop_core::CommandContext::default();

    let cli_data = crate::dispatch::dispatch(
        Commands::OpenSystemSurface(crate::cli_args::system::OpenSystemSurfaceArgs {
            surface: Surface::ActionCenter,
        }),
        &adapter,
        &report,
        &context,
    )
    .expect("the CLI path opens");

    let batch = execute(
        BatchArgs {
            commands_json:
                r#"[{"command":"open-system-surface","args":{"surface":"action-center"}}]"#.into(),
            stop_on_error: false,
            timeout_ms: 60_000,
        },
        &adapter,
        &report,
        &context,
    )
    .expect("the batch path opens");

    let entry = &batch["results"][0];
    assert_eq!(entry["command"], "open-system-surface");
    assert_eq!(entry["ok"], true);
    assert_eq!(
        serde_json::to_string(&entry["data"]).unwrap(),
        serde_json::to_string(&cli_data).unwrap(),
        "batch and CLI must emit the same bytes for the same request"
    );
    assert_eq!(cli_data["surface"], "action-center");
    assert_eq!(cli_data["window"]["id"], "w-77");

    let opens = adapter.opens.lock().unwrap();
    assert_eq!(opens.len(), 2);
    assert_eq!(opens[0], opens[1]);
    assert_eq!(opens[0].0, SnapshotSurface::ActionCenter);
}

/// An adapter with no desktop capability at all - the blanket-default
/// double - refuses the open in both paths, and the batch entry's error
/// payload is the same payload the CLI envelope emits, field for field.
#[test]
fn an_adapter_without_any_desktop_capability_answers_identically_in_both_paths() {
    let report = PermissionReport::default();
    let context = agent_desktop_core::CommandContext::default();

    let cli_error = crate::dispatch::dispatch(
        Commands::OpenSystemSurface(crate::cli_args::system::OpenSystemSurfaceArgs {
            surface: Surface::Dock,
        }),
        &NoopAdapter,
        &report,
        &context,
    )
    .expect_err("the noop adapter keeps the trait default");

    let batch = execute(
        BatchArgs {
            commands_json: r#"[{"command":"open-system-surface","args":{"surface":"dock"}}]"#
                .into(),
            stop_on_error: false,
            timeout_ms: 60_000,
        },
        &NoopAdapter,
        &report,
        &context,
    )
    .expect("the batch itself succeeds; the entry carries the error");

    let entry = &batch["results"][0];
    assert_eq!(entry["ok"], false);
    assert_eq!(entry["error"]["code"], "PLATFORM_NOT_SUPPORTED");
    assert_eq!(cli_error.code(), ErrorCode::PlatformNotSupported.as_str());
    assert_eq!(
        serde_json::to_value(
            agent_desktop_core::response::output::ErrorPayload::from_app_error(&cli_error)
        )
        .unwrap(),
        entry["error"],
        "the batch entry carries the same error payload the CLI envelope emits, \
         field for field"
    );
}
