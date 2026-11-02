use super::*;
use crate::input::mouse::mouse_send::mouse_send_fake_sink as sink;

const LEFT_UP: u32 = 0x0004;

#[test]
fn a_guard_that_never_armed_posts_nothing_on_drop() {
    sink::reset();
    {
        let _guard = ClickReleaseGuard::new(LEFT_UP);
    }

    assert!(
        sink::recorded().is_empty(),
        "a click that never pressed the button must not post a release"
    );
}

#[test]
fn a_disarmed_guard_posts_nothing_on_drop() {
    sink::reset();
    {
        let mut guard = ClickReleaseGuard::new(LEFT_UP);
        guard.arm();
        guard.disarm();
    }

    assert!(
        sink::recorded().is_empty(),
        "a normally completed click must not post a corrective release"
    );
}

#[test]
fn an_armed_guard_posts_exactly_the_corrective_up_on_drop() {
    sink::reset();
    {
        let mut guard = ClickReleaseGuard::new(LEFT_UP);
        guard.arm();
    }

    let recorded = sink::recorded();
    assert_eq!(recorded.len(), 1, "corrective button-up only");
    assert_eq!(
        recorded[0].flags, LEFT_UP,
        "the release must use the same button the click pressed"
    );
}
