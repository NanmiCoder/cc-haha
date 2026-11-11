use super::*;

/// Mirrors macOS's `standalone_key_state_is_rejected_without_emission`,
/// inverted against actually emitting anything: a held key edge has no
/// daemon to own it, so it must fail closed with zero synthesis.
#[test]
fn standalone_key_state_is_rejected_without_emission() {
    let error = reject_standalone_key_state(
        &KeyCombo {
            key: "shift".into(),
            modifiers: Vec::new(),
        },
        true,
    )
    .expect_err("stateless holds must fail closed");

    assert_eq!(error.code, ErrorCode::ActionNotSupported);
    let details = error.details.expect("standalone error carries details");
    assert_eq!(details["raw_input_emitted"], false);
    assert_eq!(details["requires_daemon_owned_transaction"], true);
    assert!(error.suggestion.is_some());
}

#[test]
fn standalone_key_up_is_rejected_the_same_way_as_key_down() {
    let combo = KeyCombo {
        key: "a".into(),
        modifiers: Vec::new(),
    };

    let down_error = reject_standalone_key_state(&combo, true).unwrap_err();
    let up_error = reject_standalone_key_state(&combo, false).unwrap_err();

    assert_eq!(down_error.code, up_error.code);
    assert_eq!(
        down_error.details.unwrap()["raw_input_emitted"],
        up_error.details.unwrap()["raw_input_emitted"]
    );
}
