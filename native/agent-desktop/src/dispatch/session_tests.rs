use super::resolve_end_session_id;
use crate::cli_args::session::{SessionAction, SessionArgs, SessionEndArgs, SessionGcArgs};
use crate::dispatch::test_support::{FailingOverlayAdapter, HomeGuard};
use crate::test_noop_ops::NoopAdapter;
use agent_desktop_core::context::CommandContext;
use agent_desktop_core::session::{ArtifactsMode, SessionTraceMode, StartSessionOptions};

#[derive(Default)]
struct OverlayAdapter {
    calls: std::sync::atomic::AtomicUsize,
    fail: bool,
}

impl agent_desktop_core::ObservationOps for OverlayAdapter {}
impl agent_desktop_core::ActionOps for OverlayAdapter {}
impl agent_desktop_core::InputOps for OverlayAdapter {}
impl agent_desktop_core::SystemOps for OverlayAdapter {
    fn update_cursor_overlay(
        &self,
        control: &agent_desktop_core::CursorOverlayControl,
    ) -> Result<(), agent_desktop_core::AdapterError> {
        assert!(control.is_enable());
        self.calls
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        if self.fail {
            Err(agent_desktop_core::AdapterError::internal(
                "renderer unavailable",
            ))
        } else {
            Ok(())
        }
    }
}

#[test]
fn session_start_reports_the_adapter_overlay_result() {
    let _home = HomeGuard::new();
    let rendering = OverlayAdapter::default();
    let failing = OverlayAdapter {
        fail: true,
        ..Default::default()
    };
    let multi_agent = OverlayAdapter::default();
    for (adapter, cursor, multi, rendered) in [
        (
            &rendering as &dyn agent_desktop_core::PlatformAdapter,
            true,
            false,
            Some(true),
        ),
        (&NoopAdapter, true, false, Some(false)),
        (&failing, true, false, Some(false)),
        (&multi_agent, true, true, Some(false)),
        (&rendering, false, false, None),
    ] {
        let value = super::dispatch(
            SessionArgs {
                action: SessionAction::Start(crate::cli_args::session::SessionStartArgs {
                    name: None,
                    no_trace: true,
                    screenshots: false,
                    cursor,
                    multi_agent: multi,
                }),
            },
            adapter,
            &CommandContext::default(),
        )
        .expect("session starts even when the renderer is unavailable");
        assert_eq!(
            value.get("rendered").and_then(serde_json::Value::as_bool),
            rendered
        );
        let id = value["session_id"].as_str().unwrap();
        let manifest = agent_desktop_core::session::read_manifest(id)
            .unwrap()
            .unwrap();
        assert_eq!(
            serde_json::to_value(manifest.cursor_overlay).unwrap()["enabled"],
            cursor
        );
    }
    assert_eq!(
        rendering.calls.load(std::sync::atomic::Ordering::Relaxed),
        1
    );
    assert_eq!(failing.calls.load(std::sync::atomic::Ordering::Relaxed), 1);
    assert_eq!(
        multi_agent.calls.load(std::sync::atomic::Ordering::Relaxed),
        0
    );
}

#[test]
fn explicit_session_end_id_precedes_active_scope() {
    assert_eq!(
        resolve_end_session_id(Some("explicit".into()), Some("active")).unwrap(),
        "explicit"
    );
}

#[test]
fn session_end_falls_back_to_active_scope() {
    assert_eq!(
        resolve_end_session_id(None, Some("active")).unwrap(),
        "active"
    );
}

#[test]
fn session_end_without_any_scope_is_invalid() {
    let error = resolve_end_session_id(None, None).expect_err("missing scope must fail");

    assert_eq!(error.code(), "INVALID_ARGS");
    assert!(error.to_string().contains("No session id"));
}

#[test]
fn scoped_session_end_is_idempotent_without_reopening_commands() {
    let _home = HomeGuard::new();
    let manifest =
        agent_desktop_core::session::start_session(StartSessionOptions::default()).unwrap();
    let context = CommandContext::new(Some(manifest.id.clone()), None, false).unwrap();
    let end = |context: &CommandContext, id| {
        crate::dispatch::dispatch(
            crate::cli::Commands::Session(SessionArgs {
                action: SessionAction::End(SessionEndArgs { id }),
            }),
            &NoopAdapter,
            &agent_desktop_core::PermissionReport::default(),
            context,
        )
        .expect("session cleanup remains repeatable")
    };
    let ended = end(&context, None);
    assert!(ended["ended_at"].is_number());
    let fresh = CommandContext::new(Some(manifest.id.clone()), None, false).unwrap();
    for context in [&context, &fresh] {
        assert_eq!(end(context, None), ended);
        assert_eq!(end(context, Some(manifest.id.clone())), ended);
        for command in [
            crate::cli::Commands::Version,
            crate::cli::Commands::Session(SessionArgs {
                action: SessionAction::List,
            }),
        ] {
            let error = crate::dispatch::dispatch(
                command,
                &NoopAdapter,
                &agent_desktop_core::PermissionReport::default(),
                context,
            )
            .expect_err("cleanup must not reopen other commands");
            assert_eq!(error.code(), "INVALID_ARGS");
        }
    }
    let saved = agent_desktop_core::session::read_manifest(&manifest.id)
        .unwrap()
        .unwrap();
    assert_eq!(serde_json::json!(saved.ended_at), ended["ended_at"]);
    let other = agent_desktop_core::session::start_session(StartSessionOptions::default()).unwrap();
    assert_eq!(
        end(&context, Some(other.id.clone()))["session_id"],
        other.id
    );
    assert!(
        agent_desktop_core::session::read_manifest(&other.id)
            .unwrap()
            .unwrap()
            .ended_at
            .is_some()
    );
    drop(fresh);
    drop(context);
    std::fs::remove_dir_all(_home.path()).unwrap();
}

#[test]
fn session_end_reports_uncertain_when_overlay_teardown_fails_after_persisting() {
    let home = HomeGuard::new();
    let manifest = agent_desktop_core::session::start_session(StartSessionOptions {
        trace: SessionTraceMode::Off,
        artifacts: ArtifactsMode::Events,
        name: None,
    })
    .unwrap();
    let result = super::dispatch(
        SessionArgs {
            action: SessionAction::End(SessionEndArgs {
                id: Some(manifest.id.clone()),
            }),
        },
        &FailingOverlayAdapter,
        &CommandContext::default(),
    );

    let error = result.expect_err("failed teardown must be surfaced");
    assert_eq!(error.code(), "ACTION_FAILED");
    assert!(error.to_string().contains("Session state was saved"));
    let agent_desktop_core::AppError::Adapter(adapter_error) = &error else {
        panic!("teardown failure must preserve adapter disposition");
    };
    assert_eq!(
        adapter_error.disposition,
        agent_desktop_core::DeliverySemantics::uncertain()
    );
    let ended = agent_desktop_core::session::read_manifest(&manifest.id)
        .unwrap()
        .expect("manifest remains readable");
    assert!(ended.ended_at.is_some());
    assert!(home.path().join("sessions").join(manifest.id).is_dir());
}

#[test]
fn a_pinned_namespace_rejects_foreign_session_end_and_global_gc() {
    let context = CommandContext::default().with_pinned_session_namespace();
    let foreign_end = super::dispatch(
        SessionArgs {
            action: SessionAction::End(SessionEndArgs {
                id: Some("other".into()),
            }),
        },
        &NoopAdapter,
        &context,
    )
    .expect_err("ending a foreign session must be rejected");
    assert_eq!(foreign_end.code(), "INVALID_ARGS");
    assert!(
        foreign_end
            .to_string()
            .contains("cannot end a foreign session")
    );

    let global_gc = super::dispatch(
        SessionArgs {
            action: SessionAction::Gc(SessionGcArgs {
                older_than: None,
                ended: false,
            }),
        },
        &NoopAdapter,
        &context,
    )
    .expect_err("global gc must be rejected in a pinned namespace");
    assert_eq!(global_gc.code(), "INVALID_ARGS");
}

#[test]
fn a_pinned_namespace_still_allows_ending_its_own_session() {
    let _home = HomeGuard::new();
    let manifest = agent_desktop_core::session::start_session(StartSessionOptions {
        trace: SessionTraceMode::Off,
        artifacts: ArtifactsMode::Events,
        name: None,
    })
    .unwrap();
    let context = CommandContext::new(Some(manifest.id.clone()), None, false)
        .unwrap()
        .with_pinned_session_namespace();
    let result = super::dispatch(
        SessionArgs {
            action: SessionAction::End(SessionEndArgs {
                id: Some(manifest.id.clone()),
            }),
        },
        &NoopAdapter,
        &context,
    );
    result.expect("a pinned namespace may end its own session");
    let ended = agent_desktop_core::session::read_manifest(&manifest.id)
        .unwrap()
        .expect("manifest remains readable");
    assert!(ended.ended_at.is_some());
}

#[test]
fn session_gc_ended_reclaims_an_ended_session_that_recorded_trace_events() {
    let home = HomeGuard::new();
    let manifest =
        agent_desktop_core::session::start_session(StartSessionOptions::default()).unwrap();
    let segment = agent_desktop_core::session::trace_dir(&manifest.id)
        .unwrap()
        .join("1-1.jsonl");
    std::fs::write(&segment, b"{\"event\":\"command.end\"}\n").unwrap();
    agent_desktop_core::session::end_session(&manifest.id).unwrap();

    let value = super::dispatch(
        SessionArgs {
            action: SessionAction::Gc(SessionGcArgs {
                older_than: Some(0),
                ended: true,
            }),
        },
        &NoopAdapter,
        &CommandContext::default(),
    )
    .expect("gc of ended sessions runs");

    assert_eq!(value["removed"], serde_json::json!([manifest.id]));
    assert!(!home.path().join("sessions").join(&manifest.id).exists());
}
