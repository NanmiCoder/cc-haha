use super::*;
use crate::cli_args::cursor_overlay::CursorOverlayArgs;
use crate::cli_args::cursor_overlay_action::CursorOverlayAction;
use crate::cli_args::cursor_overlay_enable::CursorOverlayEnableArgs;
use crate::cli_args::cursor_overlay_style::CursorOverlayStyleArgs;
use crate::dispatch::test_support::{FailingOverlayAdapter, HomeGuard, started_overlay_session};
use crate::test_noop_ops::NoopAdapter;
use agent_desktop_core::commands::session::{self, SessionAction};
use agent_desktop_core::{
    ActionOps, AdapterError, InputOps, ObservationOps, SystemOps, context::CommandContext,
};
use std::sync::Mutex;

/// An adapter whose renderer either answers or does not, which is the only
/// axis `data.rendered` reports on.
enum RenderOutcome {
    Succeed,
    Fail,
}

struct RenderingAdapter {
    outcome: RenderOutcome,
}

impl ObservationOps for RenderingAdapter {}
impl ActionOps for RenderingAdapter {}
impl InputOps for RenderingAdapter {}

impl SystemOps for RenderingAdapter {
    fn update_cursor_overlay(
        &self,
        _control: &agent_desktop_core::CursorOverlayControl,
    ) -> Result<(), AdapterError> {
        match self.outcome {
            RenderOutcome::Succeed => Ok(()),
            RenderOutcome::Fail => Err(AdapterError::internal("renderer unavailable")),
        }
    }
}

/// The one home-isolation mechanism this crate has. A second one with its own
/// lock would not exclude the first: both set `AGENT_DESKTOP_HOME`, so two
/// independent mutexes leave the tests racing over one global and failing with
/// a session whose manifest another test's home had already replaced.
fn start_session() -> String {
    let started = session::execute(SessionAction::Start {
        name: None,
        no_trace: true,
        screenshots: false,
    })
    .expect("session start");
    started["session_id"]
        .as_str()
        .expect("session id")
        .to_owned()
}

fn enable_args() -> CursorOverlayArgs {
    CursorOverlayArgs {
        action: CursorOverlayAction::Enable(Box::new(CursorOverlayEnableArgs {
            multi_agent: false,
            label: None,
            max_words: None,
            style: CursorOverlayStyleArgs::default(),
            motion: Default::default(),
        })),
    }
}

fn disable_args() -> CursorOverlayArgs {
    CursorOverlayArgs {
        action: CursorOverlayAction::Disable,
    }
}

#[test]
fn default_adapter_reports_rendered_false_on_enable() {
    let _home = HomeGuard::new();
    let session_id = start_session();
    let context = CommandContext::new(Some(session_id), None, false).expect("context");

    let value = dispatch(enable_args(), &NoopAdapter, &context).expect("enable succeeds");

    assert_eq!(value["rendered"], false);
}

#[test]
fn overriding_adapter_reports_rendered_true_on_enable() {
    let _home = HomeGuard::new();
    let session_id = start_session();
    let context = CommandContext::new(Some(session_id), None, false).expect("context");
    let adapter = RenderingAdapter {
        outcome: RenderOutcome::Succeed,
    };

    let value = dispatch(enable_args(), &adapter, &context).expect("enable succeeds");

    assert_eq!(value["rendered"], true);
}

#[test]
fn failing_adapter_reports_rendered_false_but_still_succeeds_on_enable() {
    let _home = HomeGuard::new();
    let session_id = start_session();
    let context = CommandContext::new(Some(session_id), None, false).expect("context");
    let adapter = RenderingAdapter {
        outcome: RenderOutcome::Fail,
    };

    let value = dispatch(enable_args(), &adapter, &context).expect("enable stays fail-soft");

    assert_eq!(value["rendered"], false);
}

#[test]
fn disable_never_carries_a_rendered_field() {
    let _home = HomeGuard::new();
    let session_id = start_session();
    let context = CommandContext::new(Some(session_id), None, false).expect("context");

    let rendering = RenderingAdapter {
        outcome: RenderOutcome::Succeed,
    };
    let adapters: [(&str, &dyn PlatformAdapter); 2] = [
        ("NoopAdapter", &NoopAdapter),
        ("RenderingAdapter", &rendering),
    ];

    for (name, adapter) in adapters {
        let value = dispatch(disable_args(), adapter, &context).expect("disable succeeds");
        assert!(
            value.get("rendered").is_none(),
            "{name} disable must not report rendered: {:?}",
            value.get("rendered")
        );
    }
}

/// Records the control the adapter was actually handed, which is the only
/// place the caller's label can be checked: the response envelope echoes the
/// label back from the session config whether or not the renderer ever
/// received it, so asserting on the envelope would pass with the label
/// dropped.
#[derive(Default)]
struct RecordingAdapter {
    seen: Mutex<Vec<agent_desktop_core::CursorOverlayControl>>,
}

impl ObservationOps for RecordingAdapter {}
impl ActionOps for RecordingAdapter {}
impl InputOps for RecordingAdapter {}

impl SystemOps for RecordingAdapter {
    fn update_cursor_overlay(
        &self,
        control: &agent_desktop_core::CursorOverlayControl,
    ) -> Result<(), AdapterError> {
        if let Ok(mut seen) = self.seen.lock() {
            seen.push(control.clone());
        }
        Ok(())
    }
}

/// Enabling announces the overlay with the greeting whatever the caller
/// configured, which is the shipped contract rather than a fallback: the
/// configured label rides on each action's own instruction afterwards, so the
/// first frame greets and the rest narrate.
#[test]
fn an_enable_without_a_label_still_hands_the_renderer_the_greeting() {
    let _home = HomeGuard::new();
    let session_id = start_session();
    let context = CommandContext::new(Some(session_id), None, false).expect("context");
    let adapter = RecordingAdapter::default();

    dispatch(enable_args(), &adapter, &context).expect("enable succeeds");

    let seen = adapter.seen.lock().expect("recorded controls");
    let enable = seen.first().expect("the adapter was handed a control");
    assert_eq!(
        enable.label(),
        Some(agent_desktop_core::CURSOR_OVERLAY_GREETING)
    );
}

#[test]
fn disable_reports_uncertain_when_overlay_teardown_fails_after_persisting() {
    let home = HomeGuard::new();
    let manifest = started_overlay_session();
    let context = CommandContext::new(Some(manifest.id.clone()), None, false).unwrap();
    let result = dispatch(
        CursorOverlayArgs {
            action: CursorOverlayAction::Disable,
        },
        &FailingOverlayAdapter,
        &context,
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
    let saved = agent_desktop_core::session::read_manifest(&manifest.id)
        .unwrap()
        .expect("manifest remains readable");
    assert_eq!(saved.cursor_overlay, Default::default());
    assert!(home.path().join("sessions").join(manifest.id).is_dir());
}

#[test]
fn tear_down_forgives_only_an_adapter_without_an_overlay() {
    let control = agent_desktop_core::CursorOverlayControl::disable("session".to_owned());

    tear_down(&NoopAdapter, &control).expect("an adapter with no overlay has nothing to tear down");

    let error = tear_down(&FailingOverlayAdapter, &control)
        .expect_err("any other teardown failure must surface");
    assert_eq!(error.code(), "ACTION_FAILED");
}
