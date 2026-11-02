use super::*;
use crate::actions::select::select_verify::{combo_evidence, commit_unobserved, says_something};

#[test]
fn a_matching_label_with_no_route_is_not_supported_and_not_delivered() {
    let error = no_route();
    assert_eq!(error.code, ErrorCode::ActionNotSupported);
    assert_eq!(
        error.disposition,
        agent_desktop_core::DeliverySemantics::not_delivered()
    );
}

#[test]
fn a_select_whose_read_back_is_unchanged_is_a_write_ignored_failure() {
    use super::super::chain::chain_delivery_outcome::DeliveryOutcome;
    use super::super::chain::chain_observed::Observed;
    use super::unchanged_is_ignored;
    use agent_desktop_core::ErrorCode;
    let error = unchanged_is_ignored(DeliveryOutcome::Delivered(Observed::Unchanged))
        .expect_err("unchanged is ignored");
    assert_eq!(error.code, ErrorCode::ActionFailed);
    assert_eq!(error.disposition, DeliverySemantics::delivered_unverified());
    let hint = error.suggestion.expect("recovery hint");
    assert!(!hint.contains("headed"), "{hint}");
    assert!(hint.contains("fresh snapshot"), "{hint}");
    assert_eq!(error.details.expect("details")["cause"], "write_ignored");
    for kept in [
        DeliveryOutcome::Delivered(Observed::Matched),
        DeliveryOutcome::Delivered(Observed::Unread),
        DeliveryOutcome::NotDelivered,
    ] {
        assert!(unchanged_is_ignored(kept).is_ok());
    }
}

#[test]
fn a_blank_or_object_replacement_text_says_nothing_about_the_combo_value() {
    assert!(!says_something(""));
    assert!(!says_something(" \u{fffc} "));
    assert!(says_something("Two"));
}

#[test]
fn a_combo_name_is_evidence_against_the_wanted_value_only_where_it_is_the_value() {
    assert_eq!(combo_evidence(None, Some("combo"), "beta", false), None);
    assert_eq!(combo_evidence(None, Some("sel"), "two", false), None);
    assert_eq!(
        combo_evidence(None, Some("combo"), "beta", true),
        Some(false)
    );
    assert_eq!(
        combo_evidence(None, Some("beta"), "beta", false),
        Some(true)
    );
    assert_eq!(
        combo_evidence(Some("alpha"), Some("beta"), "beta", false),
        Some(false)
    );
    assert_eq!(
        combo_evidence(Some("\u{fffc}"), Some(""), "beta", true),
        None
    );
}

#[test]
fn a_select_on_a_toolkit_that_fires_no_change_event_is_never_verified() {
    assert_eq!(commit_unobserved(true, Some(true)), None);
    assert_eq!(commit_unobserved(true, Some(false)), Some(false));
    assert_eq!(commit_unobserved(true, None), None);
    assert_eq!(commit_unobserved(false, Some(true)), Some(true));
}
