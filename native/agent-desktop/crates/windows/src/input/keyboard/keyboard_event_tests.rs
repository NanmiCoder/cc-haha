use super::*;
use crate::input::keyboard::keyboard_map;
use crate::input::keyboard::keyboard_send::key_state_fake_sink as key_state;
use crate::input::keyboard::keyboard_send::keyboard_send_fake_sink as sink;
use agent_desktop_core::{DeliverySemantics, ErrorCode};

fn reset() {
    sink::reset();
    key_state::reset();
}

#[test]
fn a_chord_presses_and_releases_every_modifier_around_the_key() {
    reset();
    let combo = KeyCombo {
        key: "a".into(),
        modifiers: vec![Modifier::Ctrl, Modifier::Shift],
    };
    synthesize_key(&combo, Deadline::after(5_000).expect("bounded deadline"))
        .expect("an ample deadline must succeed");

    let recorded = sink::recorded();
    let key_vk = keyboard_map::resolve_key("a").expect("'a' resolves").vk;
    assert_eq!(
        recorded.len(),
        6,
        "ctrl-down, shift-down, key-down, key-up, shift-up, ctrl-up"
    );
    assert_eq!(recorded[0].vk, VK_CONTROL);
    assert_eq!(recorded[0].flags, 0);
    assert_eq!(recorded[1].vk, VK_SHIFT);
    assert_eq!(recorded[1].flags, 0);
    assert_eq!(recorded[2].vk, key_vk);
    assert_eq!(recorded[2].flags, 0);
    assert_eq!(recorded[3].vk, key_vk);
    assert_eq!(recorded[3].flags, KEYEVENTF_KEYUP);
    assert_eq!(recorded[4].vk, VK_SHIFT);
    assert_eq!(recorded[4].flags, KEYEVENTF_KEYUP);
    assert_eq!(recorded[5].vk, VK_CONTROL);
    assert_eq!(recorded[5].flags, KEYEVENTF_KEYUP);
}

#[test]
fn an_unknown_key_name_is_rejected_before_any_injection() {
    reset();
    let combo = KeyCombo {
        key: "hyperkey".into(),
        modifiers: Vec::new(),
    };
    let error = synthesize_key(&combo, Deadline::after(5_000).expect("bounded deadline"))
        .expect_err("unknown key names must be rejected");

    assert_eq!(error.code, ErrorCode::InvalidArgs);
    assert!(sink::recorded().is_empty());
}

#[test]
fn an_expired_deadline_rejects_before_any_injection() {
    reset();
    let combo = KeyCombo {
        key: "a".into(),
        modifiers: Vec::new(),
    };
    let error = synthesize_key(&combo, Deadline::after(0).expect("zero-length deadline"))
        .expect_err("an expired deadline must be rejected");

    assert_eq!(error.code, ErrorCode::Timeout);
    assert!(sink::recorded().is_empty());
}

/// The release-guard sweep, inverted: only a virtual key the OS still
/// reports down gets an emergency release; a key this guard's own
/// bookkeeping still lists as held but that nothing confirms is actually
/// down is left alone rather than spuriously re-pressed.
#[test]
fn dropping_an_armed_guard_sweeps_only_keys_the_os_still_reports_down() {
    reset();
    key_state::set_down(VK_CONTROL);

    {
        let mut guard = KeyReleaseGuard::new();
        guard.note_pressed(VK_CONTROL);
        guard.note_pressed(VK_SHIFT);
    }

    let recorded = sink::recorded();
    assert_eq!(
        recorded.len(),
        1,
        "only the key the OS confirms is still down gets swept"
    );
    assert_eq!(recorded[0].vk, VK_CONTROL);
    assert_eq!(recorded[0].flags, KEYEVENTF_KEYUP);
}

#[test]
fn dropping_a_guard_with_no_keys_confirmed_down_posts_nothing() {
    reset();

    {
        let mut guard = KeyReleaseGuard::new();
        guard.note_pressed(VK_CONTROL);
    }

    assert!(
        sink::recorded().is_empty(),
        "no live confirmation means no corrective post"
    );
}

#[test]
fn a_fully_released_chord_posts_no_sweep_on_drop() {
    reset();
    key_state::set_down(VK_CONTROL);

    {
        let mut guard = KeyReleaseGuard::new();
        guard.note_pressed(VK_CONTROL);
        guard.note_released(VK_CONTROL);
    }

    assert!(
        sink::recorded().is_empty(),
        "a key already removed from the held set must not be swept"
    );
}

#[test]
fn enrich_error_reports_not_delivered_when_nothing_was_pressed() {
    let guard = KeyReleaseGuard::new();
    let error = guard.enrich_error(AdapterError::internal("pre-post failure"));

    assert_eq!(error.disposition, DeliverySemantics::not_delivered());
}

#[test]
fn enrich_error_reports_delivered_unverified_with_emergency_release_when_still_held() {
    let mut guard = KeyReleaseGuard::new();
    guard.note_pressed(VK_CONTROL);

    let error = guard.enrich_error(AdapterError::timeout("deadline"));

    assert_eq!(error.disposition, DeliverySemantics::delivered_unverified());
    let details = error.details.expect("enriched details");
    assert_eq!(details["delivered_events"], 1);
    assert_eq!(details["emergency_release_posted"], true);
    assert_eq!(details["emergency_release_acknowledged"], false);
}

#[test]
fn enrich_error_omits_emergency_release_when_everything_was_released() {
    let mut guard = KeyReleaseGuard::new();
    guard.note_pressed(VK_CONTROL);
    guard.note_released(VK_CONTROL);

    let error = guard.enrich_error(AdapterError::timeout("deadline"));

    assert_eq!(error.disposition, DeliverySemantics::delivered_unverified());
    let details = error.details.expect("enriched details");
    assert_eq!(details["delivered_events"], 2);
    assert!(details.get("emergency_release_posted").is_none());
}

/// The caller's own modifiers and the layout's requirement have to combine
/// without pressing the same key twice - and without dropping either side.
#[test]
fn a_layout_required_shift_joins_the_callers_modifiers() {
    let combo = KeyCombo {
        key: "5".into(),
        modifiers: vec![Modifier::Ctrl],
    };
    let resolved = keyboard_map::resolved_from_scan(0x0135);

    assert_eq!(
        chord_modifiers(&combo, resolved),
        vec![VK_CONTROL, VK_SHIFT]
    );
}

#[test]
fn a_modifier_the_caller_already_asked_for_is_not_pressed_twice() {
    let combo = KeyCombo {
        key: "5".into(),
        modifiers: vec![Modifier::Shift],
    };
    let resolved = keyboard_map::resolved_from_scan(0x0135);

    assert_eq!(chord_modifiers(&combo, resolved), vec![VK_SHIFT]);
}

#[test]
fn a_key_the_layout_produces_unshifted_carries_only_the_callers_modifiers() {
    let combo = KeyCombo {
        key: "a".into(),
        modifiers: vec![Modifier::Ctrl],
    };
    let resolved = keyboard_map::resolved_from_scan(0x0041);

    assert_eq!(chord_modifiers(&combo, resolved), vec![VK_CONTROL]);
}
