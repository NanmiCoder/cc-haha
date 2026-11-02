use super::verify_burst;
use crate::adapter::{ActionOps, InputOps, NativeHandle, ObservationOps, SystemOps};
use crate::{AdapterError, DeliverySemantics, actions::capability};
use serde_json::{Value, json};

struct FieldAdapter {
    value: Option<&'static str>,
}

impl ObservationOps for FieldAdapter {
    fn get_live_element(
        &self,
        _handle: &NativeHandle,
        _deadline: crate::Deadline,
    ) -> Result<crate::LiveElement, AdapterError> {
        let Some(value) = self.value else {
            return Err(AdapterError::internal("the field could not be read"));
        };
        Ok(crate::LiveElement {
            identity: crate::adapter::live_identity("Target"),
            state: crate::ElementState {
                role: "textfield".into(),
                states: Vec::new(),
                value: Some(value.into()),
                enabled: Some(true),
                hidden: Some(false),
                offscreen: Some(false),
            },
            states_complete: true,
            bounds: None,
            available_actions: vec![capability::TYPE_TEXT.into()],
        })
    }
}
impl ActionOps for FieldAdapter {}
impl InputOps for FieldAdapter {}
impl SystemOps for FieldAdapter {}

fn first_keystroke_verified() -> Value {
    json!({
        "action": "type_text",
        "post_state": { "role": "textfield", "value": "h" },
        "disposition": DeliverySemantics::delivered_verified(),
        "details": { "verification_scope": "element_value" },
    })
}

fn verified(adapter: &FieldAdapter, expected: Option<&str>) -> Value {
    let mut result = first_keystroke_verified();
    verify_burst(&mut result, adapter, &NativeHandle::null(), expected);
    result
}

#[test]
fn a_burst_that_left_the_whole_text_stays_verified_with_the_final_field() {
    let result = verified(
        &FieldAdapter {
            value: Some("hello"),
        },
        Some("hello"),
    );

    assert_eq!(
        result["disposition"],
        json!(DeliverySemantics::delivered_verified())
    );
    assert_eq!(result["post_state"]["value"], "hello");
}

#[test]
fn a_burst_whose_field_reads_otherwise_is_reported_unverified() {
    let result = verified(
        &FieldAdapter {
            value: Some("helo"),
        },
        Some("hello"),
    );

    assert_eq!(
        result["disposition"],
        json!(DeliverySemantics::delivered_unverified())
    );
    assert_eq!(
        result["details"]["verification_reason"],
        "postcondition_mismatch"
    );
    assert_eq!(result["post_state"]["value"], "helo");
}

#[test]
fn a_failed_final_read_drops_the_stale_field_and_says_so() {
    let result = verified(&FieldAdapter { value: None }, Some("hello"));

    assert_eq!(
        result["disposition"],
        json!(DeliverySemantics::delivered_unverified())
    );
    assert_eq!(
        result["details"]["verification_reason"],
        "final_read_failed"
    );
    assert!(
        result.get("post_state").is_none(),
        "keystroke 1's field is not the last"
    );
}

#[test]
fn text_typed_part_way_through_the_field_cannot_be_verified() {
    let result = verified(
        &FieldAdapter {
            value: Some("ahellob"),
        },
        None,
    );

    assert_eq!(
        result["disposition"],
        json!(DeliverySemantics::delivered_unverified())
    );
    assert_eq!(
        result["details"]["verification_reason"],
        "insufficient_evidence"
    );
}
