use super::*;

fn type_after_focus(headed: bool, already_focused: bool) -> Result<ActionResult, AdapterError> {
    let states = if already_focused {
        vec!["focused"]
    } else {
        vec![]
    };
    let mut adapter = adapter(
        element(Some("before"), &states),
        element(Some("inserted"), &["focused"]),
    );
    adapter.selection = Some(0..0);
    let action = Action::TypeText("inserted".into());
    let request = if headed {
        ActionRequest::headed(action)
    } else {
        ActionRequest::headless(action)
    };
    execute_verified_action(
        &adapter,
        &NativeHandle::null(),
        request,
        &InteractionLease::guarded(Deadline::after(1000).unwrap(), ()).unwrap(),
    )
}

#[test]
fn headed_typing_does_not_treat_a_pre_focus_selection_as_delivery_evidence() {
    let result = type_after_focus(true, false).unwrap();
    assert_eq!(
        result.disposition(),
        DeliverySemantics::delivered_unverified()
    );
    assert_eq!(
        result.post_state.unwrap().value.as_deref(),
        Some("inserted")
    );
    assert_eq!(result.details.unwrap()["verification_scope"], "unavailable");
}

#[test]
fn focused_and_headless_typing_still_reject_contradictory_insertions() {
    for (headed, focused) in [(true, true), (false, false)] {
        let error = type_after_focus(headed, focused).unwrap_err();
        assert_eq!(error.code, ErrorCode::ActionFailed);
        assert_eq!(error.disposition, DeliverySemantics::delivered_unverified());
    }
}
