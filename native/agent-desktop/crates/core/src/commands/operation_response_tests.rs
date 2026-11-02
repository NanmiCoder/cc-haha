use super::*;
use crate::{ActionResult, OperationTarget, Point};
use serde_json::json;

fn report(result: ActionResult) -> OperationReport {
    OperationReport::new(
        result,
        OperationTarget::Pointer {
            point: Point { x: 1.0, y: 2.0 },
        },
    )
}

#[test]
fn response_carries_report_fields_and_request_context() {
    let report = report(ActionResult::delivered_unverified("mouse-click"));
    let value = operation_response(&report, json!({ "x": 1.0, "count": 2 })).unwrap();

    assert_eq!(value["action"], "mouse-click");
    assert_eq!(value["disposition"]["delivery"], "delivered_unverified");
    assert_eq!(value["target"]["kind"], "pointer");
    assert_eq!(value["x"], 1.0);
    assert_eq!(value["count"], 2);
}

#[test]
fn response_never_claims_an_unproven_success_flag() {
    let report = report(ActionResult::delivered_unverified("mouse-click"));
    let value = operation_response(&report, json!({})).unwrap();

    for flag in ["clicked", "moved", "dragged", "closed", "cleared", "ok"] {
        assert!(value.get(flag).is_none(), "{flag}");
    }
}

#[test]
fn request_context_cannot_overwrite_report_fields() {
    let report = report(ActionResult::delivered_unverified("mouse-click"));
    let value = operation_response(&report, json!({ "action": "forged" })).unwrap();

    assert_eq!(value["action"], "mouse-click");
}

#[test]
fn delivery_in_keeps_verified_and_satisfied_reports() {
    let verified = serde_json::to_value(report(
        ActionResult::delivered_unverified("move").with_verified_delivery(),
    ))
    .unwrap();
    let satisfied =
        serde_json::to_value(report(ActionResult::satisfied_without_delivery("minimize"))).unwrap();

    assert_eq!(
        delivery_in(&verified),
        DeliverySemantics::delivered_verified()
    );
    assert_eq!(delivery_in(&satisfied), DeliverySemantics::not_delivered());
}

#[test]
fn delivery_in_defaults_to_unverified_without_a_valid_disposition() {
    for value in [
        json!({}),
        json!({ "disposition": "bad" }),
        json!({ "disposition": { "delivery": "unknown", "retry": "unknown" } }),
    ] {
        assert_eq!(
            delivery_in(&value),
            DeliverySemantics::delivered_unverified()
        );
    }
}
