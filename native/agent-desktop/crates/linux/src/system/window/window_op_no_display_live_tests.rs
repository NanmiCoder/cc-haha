use agent_desktop_core::{DeliverySemantics, ErrorCode, WindowInfo, WindowOp};

use super::{CHILD_MARKER, apply, child_window, geometry, in_child, xid_of};
use crate::system::SharedBus;
use crate::tree::live::live_launch::Launched;

const TARGET: &str = "AGENT_DESKTOP_WINDOW_OP_TARGET";

#[test]
#[ignore = "drives real desktop applications; run through scripts/private-session.sh --wm"]
fn window_op_live_a_session_without_a_display_is_refused_before_any_write() {
    let bus = SharedBus::default();
    let mut launched = Launched::new();
    let window = child_window(&bus, &mut launched);
    let xid = xid_of(window.pid.get());
    let before = geometry(&xid);
    let target = serde_json::to_string(&window).unwrap();
    in_child("no_display::window_op_live_child_no_display", |command| {
        command.env_remove("DISPLAY").env(TARGET, target);
    });
    let after = geometry(&xid);
    assert_eq!(
        (after.x, after.y, after.width, after.height),
        (before.x, before.y, before.width, before.height),
        "the independent X11 oracle sees no window mutation"
    );
}

#[test]
#[ignore = "runs only inside the parent test that sets its environment"]
fn window_op_live_child_no_display() {
    if std::env::var_os(CHILD_MARKER).is_none() {
        return;
    }
    let window: WindowInfo = serde_json::from_str(&std::env::var(TARGET).unwrap()).unwrap();
    let error = apply(&window, WindowOp::Move { x: 60.0, y: 70.0 }).expect_err("a refusal");
    assert_eq!(error.code, ErrorCode::ActionFailed);
    assert_eq!(error.disposition, DeliverySemantics::not_delivered());
    assert_eq!(error.details.unwrap()["cause"], "x11_unavailable");
}
