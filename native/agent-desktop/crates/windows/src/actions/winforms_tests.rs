use super::{LEGACY_VALUE_LABEL, legacy_edit_judged_for, matches_native_class};
use crate::actions::chain::DeliveryOutcome;
use crate::system::fixture::test_time::deadline;
use agent_desktop_core::{DeliveryDisposition, ErrorCode, StepMechanism};

#[test]
fn identifies_only_the_requested_winforms_native_control_class() {
    assert!(matches_native_class(
        "WindowsForms10.BUTTON.app.0.34f5582_r6_ad1",
        "BUTTON"
    ));
    assert!(matches_native_class("WindowsForms10.EDIT.app.0", "EDIT"));
    assert!(!matches_native_class("WindowsForms10.EDIT.app.0", "BUTTON"));
    assert!(!matches_native_class(
        "WindowsForms10.EDITABLE.app.0",
        "EDIT"
    ));
    assert!(!matches_native_class("Edit", "EDIT"));
}

#[test]
fn a_legacy_write_preserves_the_semantic_receipt_and_verification() {
    let steps = legacy_edit_judged_for(deadline(5_000), true, true, || {
        Ok(DeliveryOutcome::DeliveredVerified)
    })
    .unwrap();
    assert_eq!(steps[0].label(), LEGACY_VALUE_LABEL);
    assert_eq!(steps[0].mechanism(), Some(StepMechanism::SemanticApi));
    assert_eq!(steps[0].verified(), Some(true));
}

#[test]
fn unsupported_and_readonly_legacy_writes_are_never_dispatched() {
    for (writable, legacy_available, code) in [
        (false, true, ErrorCode::ActionFailed),
        (true, false, ErrorCode::PolicyDenied),
    ] {
        let error = legacy_edit_judged_for(deadline(5_000), writable, legacy_available, || {
            panic!("unavailable legacy edit must not run")
        })
        .unwrap_err();
        assert_eq!(error.code, code);
        assert_eq!(
            error.disposition.delivery(),
            DeliveryDisposition::NotDelivered
        );
    }
}
