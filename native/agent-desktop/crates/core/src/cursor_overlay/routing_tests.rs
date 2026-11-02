use super::*;
use crate::{
    CommandContext, MouseButton, MouseEvent, MouseEventKind, Point,
    adapter::{ActionOps, InputOps, ObservationOps, SystemOps},
};
use std::sync::Mutex;

struct RoutingCaptureAdapter {
    presented: Mutex<Vec<CursorOverlayControl>>,
}

impl RoutingCaptureAdapter {
    fn new() -> Self {
        Self {
            presented: Mutex::new(Vec::new()),
        }
    }
}

impl ObservationOps for RoutingCaptureAdapter {}
impl ActionOps for RoutingCaptureAdapter {}

impl InputOps for RoutingCaptureAdapter {
    fn mouse_event(
        &self,
        _event: MouseEvent,
        _lease: &crate::InteractionLease,
    ) -> Result<crate::OperationReport, crate::AdapterError> {
        Ok(crate::adapter::test_report())
    }
}

impl SystemOps for RoutingCaptureAdapter {
    crate::adapter::guarded_interaction_lease!();

    fn update_cursor_overlay(
        &self,
        control: &CursorOverlayControl,
    ) -> Result<(), crate::AdapterError> {
        self.presented.lock().unwrap().push(control.clone());
        Ok(())
    }
}

fn context(multi_agent: bool, agent: &str) -> CommandContext {
    let config = CursorOverlayConfig::enabled(None, 6)
        .expect("valid config")
        .with_multi_agent(multi_agent);
    CommandContext::default()
        .with_agent_id(Some(agent.into()))
        .expect("valid agent id")
        .with_cursor_overlay_session("test-session", config)
}

fn click_event() -> MouseEvent {
    MouseEvent {
        kind: MouseEventKind::Move,
        point: Point { x: 10.0, y: 20.0 },
        button: MouseButton::Left,
        modifiers: Vec::new(),
    }
}

fn lease() -> crate::InteractionLease {
    let deadline = crate::Deadline::detached_after(5_000).expect("valid deadline");
    crate::InteractionLease::guarded(deadline, ()).expect("valid lease")
}

/// Ordinary (non-multi-agent) sessions must route `--agent-id` desktop actions
/// to the default renderer so the existing default socket handles the
/// presentation instead of spawning a second per-agent renderer.
#[test]
fn ordinary_session_routes_agent_actions_to_the_default_socket() {
    let adapter = RoutingCaptureAdapter::new();
    dispatch_mouse_event_with_cursor(
        &adapter,
        &context(false, "agent-a"),
        click_event(),
        true,
        &lease(),
    )
    .expect("dispatch succeeds");
    let presented = adapter.presented.lock().unwrap();
    assert!(!presented.is_empty(), "no cursor controls were presented");
    assert!(
        presented.iter().all(|control| control.agent_id().is_none()),
        "ordinary sessions must not stamp agent ids on present controls"
    );
}

/// Multi-agent sessions must route `--agent-id` desktop actions to the
/// per-agent renderer, preserving the per-cursor contract.
#[test]
fn multi_agent_session_routes_agent_actions_to_the_per_agent_socket() {
    let adapter = RoutingCaptureAdapter::new();
    dispatch_mouse_event_with_cursor(
        &adapter,
        &context(true, "agent-a"),
        click_event(),
        true,
        &lease(),
    )
    .expect("dispatch succeeds");
    let presented = adapter.presented.lock().unwrap();
    assert!(!presented.is_empty(), "no cursor controls were presented");
    assert!(
        presented
            .iter()
            .all(|control| control.agent_id() == Some("agent-a")),
        "multi-agent sessions must stamp the agent id on present controls"
    );
}

/// `cancel_drag` in an ordinary session must hide the default renderer; the
/// unconditional stamp previously dropped the `Hide` when the per-agent
/// socket did not exist, leaving the default cursor visible.
#[test]
fn ordinary_session_cancel_drag_routes_to_the_default_socket() {
    let adapter = RoutingCaptureAdapter::new();
    crate::cursor_overlay::cancel_drag(&adapter, &context(false, "agent-a"));
    let presented = adapter.presented.lock().unwrap();
    let cancel = presented.last().expect("cancel control");
    assert!(cancel.is_hide());
    assert_eq!(cancel.agent_id(), None);
}

/// `cancel_drag` in a multi-agent session must hide the per-agent renderer,
/// preserving the per-agent visibility scope.
#[test]
fn multi_agent_session_cancel_drag_routes_to_the_per_agent_socket() {
    let adapter = RoutingCaptureAdapter::new();
    crate::cursor_overlay::cancel_drag(&adapter, &context(true, "agent-a"));
    let presented = adapter.presented.lock().unwrap();
    let cancel = presented.last().expect("cancel control");
    assert!(cancel.is_hide());
    assert_eq!(cancel.agent_id(), Some("agent-a"));
}

fn context_with_pointer_image() -> CommandContext {
    let mut style = CursorOverlayStyle::default();
    let hand = std::env::temp_dir().join("hand.png");
    style.set_pointer_image(Some(
        crate::CursorImage::new(
            hand.to_string_lossy().into_owned(),
            Point { x: 8.0, y: 0.0 },
        )
        .expect("valid pointer image"),
    ));
    let config = CursorOverlayConfig::enabled(None, 6)
        .and_then(|config| config.with_style(style))
        .expect("valid config");
    CommandContext::default().with_cursor_overlay_session("test-session", config)
}

#[test]
fn without_a_pointer_image_travel_never_carries_the_pointer_flag() {
    let adapter = RoutingCaptureAdapter::new();
    dispatch_mouse_event_with_cursor(
        &adapter,
        &context(false, "agent-a"),
        click_event(),
        true,
        &lease(),
    )
    .expect("dispatch succeeds");
    let presented = adapter.presented.lock().unwrap();
    assert!(!presented.is_empty(), "no cursor controls were presented");
    assert!(
        presented
            .iter()
            .all(|control| !serde_json::to_string(control).unwrap().contains("pointer")),
        "controls must stay readable by renderers that predate pointer images"
    );
}

#[test]
fn a_control_whose_style_is_out_of_range_fails_its_own_validation() {
    let mut style = CursorOverlayStyle::default();
    style.set_size(100_000.0);
    let control = CursorOverlayControl::enable("run-1".into(), style);
    assert!(control.validate().is_err());
    assert!(
        CursorOverlayControl::enable("run-1".into(), CursorOverlayStyle::default())
            .validate()
            .is_ok()
    );
}

#[test]
fn a_coordinate_click_arrives_as_the_pointer_and_a_move_as_the_arrow() {
    for (click, pointer) in [(true, true), (false, false)] {
        let adapter = RoutingCaptureAdapter::new();
        dispatch_mouse_event_with_cursor(
            &adapter,
            &context_with_pointer_image(),
            click_event(),
            click,
            &lease(),
        )
        .expect("dispatch succeeds");
        let presented = adapter.presented.lock().unwrap();
        let travel = presented[0].instruction().expect("travel instruction");
        assert_eq!(travel.phase(), CursorPhase::Travel);
        assert_eq!(travel.is_pointer(), pointer, "click {click}");
        assert!(
            presented[1..]
                .iter()
                .all(|control| !control.instruction().is_some_and(|i| i.is_pointer())),
            "only the travel decides the image"
        );
    }
}

#[test]
fn the_pointer_flag_is_omitted_from_json_unless_set() {
    let config = CursorOverlayConfig::enabled(None, 6).expect("valid config");
    let arrow = CursorOverlayInstruction::new(Point { x: 1.0, y: 2.0 }, &config, false).unwrap();
    assert!(!serde_json::to_string(&arrow).unwrap().contains("pointer"));
    let pointer = arrow.with_pointer(true);
    let json = serde_json::to_string(&pointer).unwrap();
    assert!(json.contains(r#""pointer":true"#));
    let parsed: CursorOverlayInstruction = serde_json::from_str(&json).unwrap();
    assert!(parsed.is_pointer());
}
