use super::*;
use crate::{ActionStep, Point, ProcessIdentity, StepMechanism};
use serde_json::json;

fn pointer() -> OperationTarget {
    OperationTarget::Pointer {
        point: Point { x: 1.0, y: 2.0 },
    }
}

#[test]
fn report_flattens_result_beside_target() {
    let result = ActionResult::delivered_unverified("mouse-click").with_steps(vec![
        ActionStep::succeeded("click").with_mechanism(StepMechanism::PhysicalSynthetic),
    ]);
    let value = serde_json::to_value(OperationReport::new(result, pointer())).unwrap();

    assert_eq!(value["action"], "mouse-click");
    assert_eq!(value["disposition"]["delivery"], "delivered_unverified");
    assert_eq!(value["disposition"]["retry"], "unsafe");
    assert_eq!(value["steps"][0]["mechanism"], "physical_synthetic");
    assert_eq!(
        value["target"],
        json!({"kind": "pointer", "point": {"x": 1.0, "y": 2.0}})
    );
}

#[test]
fn window_and_app_targets_carry_process_identity() {
    let process = ProcessIdentity::new(42u32, "boot-1");
    let window = serde_json::to_value(OperationTarget::Window {
        id: "w-1".into(),
        title: "Doc".into(),
        process: process.clone(),
    })
    .unwrap();
    let app = serde_json::to_value(OperationTarget::App {
        name: "Notes".into(),
        process,
    })
    .unwrap();

    assert_eq!(window["kind"], "window");
    assert_eq!(window["process"], json!({"pid": 42, "instance": "boot-1"}));
    assert_eq!(app["kind"], "app");
    assert_eq!(app["process"]["instance"], "boot-1");
}

#[test]
fn drag_and_clipboard_targets_serialize_by_kind() {
    let drag = serde_json::to_value(OperationTarget::Drag {
        from: Point { x: 0.0, y: 0.0 },
        to: Point { x: 5.0, y: 6.0 },
    })
    .unwrap();

    assert_eq!(drag["kind"], "drag");
    assert_eq!(drag["to"], json!({"x": 5.0, "y": 6.0}));
    assert_eq!(
        serde_json::to_value(OperationTarget::Clipboard).unwrap(),
        json!({"kind": "clipboard"})
    );
}

#[test]
fn report_round_trips_with_explicit_disposition() {
    let report = OperationReport::new(
        ActionResult::satisfied_without_delivery("minimize"),
        OperationTarget::Clipboard,
    );
    let value = serde_json::to_value(&report).unwrap();
    let back: OperationReport = serde_json::from_value(value).unwrap();

    assert_eq!(back.disposition(), DeliverySemantics::not_delivered());
    assert_eq!(back.target, OperationTarget::Clipboard);
}

#[test]
fn report_without_disposition_is_rejected() {
    let value = json!({"action": "drag", "target": {"kind": "clipboard"}});

    assert!(serde_json::from_value::<OperationReport>(value).is_err());
}

#[test]
fn report_with_unknown_or_uncertain_disposition_is_rejected() {
    for (delivery, retry) in [("unknown", "unknown"), ("delivery_uncertain", "unsafe")] {
        let value = json!({
            "action": "drag",
            "disposition": {"delivery": delivery, "retry": retry},
            "target": {"kind": "clipboard"},
        });

        assert!(serde_json::from_value::<OperationReport>(value).is_err());
    }
}
