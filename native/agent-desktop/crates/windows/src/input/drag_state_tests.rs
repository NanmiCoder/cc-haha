use super::*;
use crate::input::mouse::mouse_send::MOUSEEVENTF_MOVE;
use crate::input::mouse::mouse_send::mouse_send_fake_sink as sink;
use agent_desktop_core::DeliverySemantics;

fn origin() -> NormalizedPoint {
    NormalizedPoint {
        x: 111,
        y: 222,
        virtual_desktop: false,
    }
}

#[test]
fn never_armed_guard_reports_not_delivered_and_no_release() {
    let guard = DragReleaseGuard::new(origin());
    let error = guard.enrich_error(AdapterError::internal("pre-post failure"));

    assert_eq!(error.disposition, DeliverySemantics::not_delivered());
    assert!(!guard.should_release());
}

#[test]
fn armed_guard_with_deliveries_reports_delivered_unverified_and_emergency_release() {
    let mut guard = DragReleaseGuard::new(origin());
    guard.arm();
    for _ in 0..4 {
        guard.mark_delivered();
    }
    let error = guard.enrich_error(AdapterError::timeout("deadline"));

    assert_eq!(error.disposition, DeliverySemantics::delivered_unverified());
    let details = error.details.expect("enriched details");
    assert_eq!(details["delivered_events"], 4);
    assert_eq!(details["emergency_release_posted"], true);
    assert_eq!(details["emergency_release_acknowledged"], false);
}

#[test]
fn disarmed_guard_posts_nothing_on_drop() {
    sink::reset();
    {
        let mut guard = DragReleaseGuard::new(origin());
        guard.arm();
        guard.mark_delivered();
        guard.disarm();
    }

    assert!(
        sink::recorded().is_empty(),
        "a normally completed drag must not post a corrective release"
    );
}

#[test]
fn armed_guard_posts_corrective_move_and_release_at_origin_on_drop() {
    sink::reset();
    {
        let mut guard = DragReleaseGuard::new(origin());
        guard.arm();
        guard.mark_delivered();
    }

    let recorded = sink::recorded();
    assert_eq!(recorded.len(), 2, "move-back to origin, then release");
    assert_eq!(recorded[0].dx, origin().x);
    assert_eq!(recorded[0].dy, origin().y);
    assert_eq!(recorded[0].flags & MOUSEEVENTF_MOVE, MOUSEEVENTF_MOVE);
    assert_eq!(recorded[1].flags, MOUSEEVENTF_LEFTUP);
}
