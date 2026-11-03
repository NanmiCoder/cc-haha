use agent_desktop_core::{ActionResult, AdapterError, DeliverySemantics, ErrorCode};

use super::started;

#[test]
fn only_started_actions_are_recorded() {
    let refused: Result<ActionResult, _> =
        Err(AdapterError::new(ErrorCode::ActionFailed, "refused")
            .with_disposition(DeliverySemantics::not_delivered()));
    assert!(!started(&refused));
    let already_satisfied = Ok(ActionResult::satisfied_without_delivery("check"));
    assert!(
        !started(&already_satisfied),
        "a successful no-op did not deliver an action"
    );
    let uncertain: Result<ActionResult, _> =
        Err(AdapterError::new(ErrorCode::ActionFailed, "unconfirmed")
            .with_disposition(DeliverySemantics::uncertain()));
    assert!(started(&uncertain));
    assert!(started(&Ok::<_, AdapterError>(
        ActionResult::delivered_unverified("check")
    )));
}
