use super::*;

#[test]
fn canonical_json_roundtrips() {
    for semantics in [
        DeliverySemantics::unknown(),
        DeliverySemantics::not_delivered(),
        DeliverySemantics::uncertain(),
        DeliverySemantics::delivered_unverified(),
        DeliverySemantics::delivered_verified(),
    ] {
        let value = serde_json::to_value(semantics).unwrap();
        assert_eq!(
            serde_json::from_value::<DeliverySemantics>(value).unwrap(),
            semantics
        );
    }
}

#[test]
fn impossible_retry_safe_delivery_is_rejected() {
    let error = serde_json::from_value::<DeliverySemantics>(serde_json::json!({
        "delivery": "delivered_verified",
        "retry": "safe",
    }))
    .unwrap_err();

    assert!(error.to_string().contains("inconsistent"));
}
