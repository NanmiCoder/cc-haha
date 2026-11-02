use super::*;
use agent_desktop_core::{
    Deadline, InteractionLease, Modifier, MouseButton, MouseEvent, MouseEventKind, Point,
};

#[test]
fn standalone_edges_refuse_before_backend_lookup() {
    let deadline = Deadline::detached_after(2_000).unwrap();
    let lease = InteractionLease::guarded(deadline, ()).unwrap();
    for (kind, direction) in [(MouseEventKind::Down, "down"), (MouseEventKind::Up, "up")] {
        let event = MouseEvent {
            kind: kind.clone(),
            point: Point { x: 10.0, y: 10.0 },
            button: MouseButton::Left,
            modifiers: vec![Modifier::Ctrl],
        };
        let error =
            crate::input::deliver::mouse_event(&event, &lease).expect_err("held edge refusal");
        assert_eq!(error.code, ErrorCode::ActionNotSupported);
        assert_eq!(
            error.message,
            format!("Standalone mouse_event {direction} is unavailable in stateless mode")
        );
        assert_eq!(error.details.as_ref().unwrap()["raw_input_emitted"], false);
        assert_eq!(
            error.details.as_ref().unwrap()["requires_daemon_owned_transaction"],
            true
        );
        assert_eq!(
            error.suggestion.as_deref(),
            Some(
                "Use the atomic 'press', 'mouse-click' or 'drag'; spanning holds require a daemon-owned session that can release input after disconnect"
            )
        );
        assert_eq!(error.disposition, DeliverySemantics::not_delivered());
    }
}
