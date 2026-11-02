use super::press_modifiers;
use crate::input::keyboard::keyboard_send::keyboard_send_fake_sink as sink;
use crate::input::mouse::fixture::modifier_events as recorded_pairs;
use agent_desktop_core::Modifier;

const VK_SHIFT: u16 = 0x10;
const VK_CONTROL: u16 = 0x11;

#[test]
fn pressing_a_modifier_posts_a_key_down_immediately() {
    sink::reset();

    let guard = press_modifiers(&[Modifier::Ctrl]);

    assert_eq!(recorded_pairs(), vec![(VK_CONTROL, false)]);
    drop(guard);
}

#[test]
fn releasing_the_guard_posts_a_key_up_for_every_pressed_modifier() {
    sink::reset();

    let mut guard = press_modifiers(&[Modifier::Ctrl, Modifier::Shift]);
    guard.release();

    assert_eq!(
        recorded_pairs(),
        vec![
            (VK_CONTROL, false),
            (VK_SHIFT, false),
            (VK_SHIFT, true),
            (VK_CONTROL, true),
        ],
        "release must sweep every held modifier, most-recently-pressed first"
    );
}

#[test]
fn dropping_an_unreleased_guard_still_releases_every_modifier() {
    sink::reset();

    {
        let _guard = press_modifiers(&[Modifier::Alt]);
    }

    let recorded = recorded_pairs();
    assert_eq!(
        recorded.len(),
        2,
        "a dropped guard must not leave a key held"
    );
    assert!(
        recorded.iter().any(|(_, up)| *up),
        "the drop must post the release"
    );
}

#[test]
fn releasing_twice_never_double_posts() {
    sink::reset();

    let mut guard = press_modifiers(&[Modifier::Meta]);
    guard.release();
    guard.release();
    drop(guard);

    let up_count = recorded_pairs().iter().filter(|(_, up)| *up).count();
    assert_eq!(
        up_count, 1,
        "an explicit release plus a later drop must post exactly one up"
    );
}

#[test]
fn no_modifiers_presses_and_releases_nothing() {
    sink::reset();

    drop(press_modifiers(&[]));

    assert!(recorded_pairs().is_empty());
}
