use super::*;
use agent_desktop_core::DeliveryDisposition;

const INTEGRITY_RID_MEDIUM: u32 = 0x2000;
const INTEGRITY_RID_HIGH: u32 = 0x3000;

#[test]
fn equal_or_lower_integrity_is_not_strictly_higher() {
    assert!(!integrity_is_strictly_higher(
        Some(INTEGRITY_RID_HIGH),
        Some(INTEGRITY_RID_MEDIUM)
    ));
    assert!(!integrity_is_strictly_higher(
        Some(INTEGRITY_RID_MEDIUM),
        Some(INTEGRITY_RID_MEDIUM)
    ));
}

#[test]
fn strictly_higher_integrity_is_detected_from_synthetic_rids() {
    assert!(integrity_is_strictly_higher(
        Some(INTEGRITY_RID_MEDIUM),
        Some(INTEGRITY_RID_HIGH)
    ));
}

#[test]
fn unreadable_integrity_sides_are_not_strictly_higher() {
    assert!(!integrity_is_strictly_higher(
        Some(INTEGRITY_RID_MEDIUM),
        None
    ));
    assert!(!integrity_is_strictly_higher(
        None,
        Some(INTEGRITY_RID_HIGH)
    ));
    assert!(!integrity_is_strictly_higher(None, None));
}

#[test]
fn budget_exhaustion_on_strictly_higher_integrity_is_activation_perm_denied() {
    let error = budget_exhausted(true);
    assert_eq!(error.code, ErrorCode::PermDenied);
    assert!(
        error.message.contains("window activation"),
        "denial must be activation-worded, got {}",
        error.message
    );
    assert!(
        !error.message.contains("blocks input"),
        "must not reuse the input-worded UIPI message"
    );
    assert_eq!(
        error.disposition.delivery(),
        DeliveryDisposition::NotDelivered
    );
    assert_eq!(
        error
            .details
            .as_ref()
            .and_then(|details| details.get("physical_delivery_started")),
        Some(&serde_json::Value::Bool(false))
    );
}

#[test]
fn budget_exhaustion_on_equal_integrity_is_action_failed_not_delivered() {
    let error = budget_exhausted(false);
    assert_eq!(error.code, ErrorCode::ActionFailed);
    assert_eq!(
        error.disposition.delivery(),
        DeliveryDisposition::NotDelivered
    );
    assert_eq!(
        error
            .details
            .as_ref()
            .and_then(|details| details.get("physical_delivery_started")),
        Some(&serde_json::Value::Bool(false))
    );
}
