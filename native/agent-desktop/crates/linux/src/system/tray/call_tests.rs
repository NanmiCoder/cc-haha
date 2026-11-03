use agent_desktop_core::{DeliveryDisposition, ErrorCode};

use super::*;
use crate::tree::live::test_support::{client_timeout, method_error};

#[test]
fn a_name_that_left_the_bus_is_a_stale_ref_that_delivered_nothing() {
    for name in [SERVICE_UNKNOWN, NAME_HAS_NO_OWNER] {
        let error = fault(&method_error(name));
        assert_eq!(error.code, ErrorCode::StaleRef, "{name}");
        assert_eq!(
            error.disposition.delivery(),
            DeliveryDisposition::NotDelivered
        );
    }
}

#[test]
fn a_method_the_item_does_not_implement_is_not_supported_and_not_delivered() {
    for name in [UNKNOWN_METHOD, UNKNOWN_OBJECT, UNKNOWN_INTERFACE] {
        let error = fault(&method_error(name));
        assert_eq!(error.code, ErrorCode::ActionNotSupported, "{name}");
        assert_eq!(
            error.disposition.delivery(),
            DeliveryDisposition::NotDelivered
        );
    }
}

#[test]
fn a_timeout_leaves_delivery_uncertain() {
    let error = fault(&client_timeout());
    assert_eq!(error.code, ErrorCode::Timeout);
    assert_eq!(
        error.disposition.delivery(),
        DeliveryDisposition::DeliveryUncertain
    );
}

#[test]
fn another_receiver_error_is_an_action_failure() {
    let error = fault(&method_error("org.example.Error.Broken"));
    assert_eq!(error.code, ErrorCode::ActionFailed);
}
