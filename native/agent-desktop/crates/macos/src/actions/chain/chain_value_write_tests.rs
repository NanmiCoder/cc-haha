use super::finite_target;

#[test]
fn increments_stop_at_overshoot_stalls_or_motion_away_from_target() {
    for (before, after, target, expected) in [
        ("5", "6", "5.5", false),
        ("6", "5", "5.5", false),
        ("5", "5", "6", false),
        ("5", "4", "6", false),
        ("4", "5", "6", true),
        ("5", "6", "6", true),
        (
            "9007199254740992",
            "9007199254740993",
            "9007199254740994",
            true,
        ),
    ] {
        assert_eq!(
            super::imp::increment_progressed(before, after, target),
            expected
        );
    }
}

#[test]
fn finite_target_rejects_non_finite_numbers() {
    assert_eq!(finite_target("42.5"), Some(42.5));
    assert_eq!(finite_target("NaN"), None);
    assert_eq!(finite_target("inf"), None);
    assert_eq!(finite_target("-inf"), None);
    assert_eq!(finite_target("not-a-number"), None);
}

#[test]
fn increment_direction_never_guesses_from_rounded_large_fractions() {
    for (current, target, expected) in [
        ("0", "0.4", Some("AXIncrement")),
        ("1.4", "1", Some("AXDecrement")),
        ("9007199254740992", "9007199254740993", Some("AXIncrement")),
        ("9007199254740993", "9007199254740992", Some("AXDecrement")),
        ("9007199254740992", "9007199254740992.5", None),
        ("9007199254740992.5", "9007199254740992", None),
        ("-9007199254740992", "-9007199254740992.5", None),
        ("1e30", "1.000000000000000001e30", None),
        ("2", "2", None),
        ("NaN", "1", None),
    ] {
        assert_eq!(
            super::increment_action(current, target),
            expected,
            "{current} → {target}"
        );
    }
}

#[test]
fn increment_requires_the_requested_fractional_value() {
    assert!(!super::increment_target_reached("0", "0.4"));
    assert!(!super::increment_target_reached(
        "9007199254740992",
        "9007199254740993"
    ));
    assert!(!super::increment_target_reached("1", "1.4"));
    assert!(super::increment_target_reached(
        "0.30000000000000004",
        "0.3"
    ));
}
