use std::time::Duration;

use agent_desktop_core::{Deadline, DeliveryDisposition, ErrorCode, NativeHandle};
use zbus::zvariant::DynamicType;

use super::*;
use crate::actions::context::Target;
use crate::system::SharedBus;
use crate::tree::AtspiElement;

fn reply_with<B: zbus::export::serde::Serialize + DynamicType>(body: &B) -> Message {
    Message::method_call("/probe", "Probe")
        .and_then(|builder| builder.build(body))
        .expect("a message builds")
}

#[test]
fn a_false_return_is_an_absent_affordance_for_every_flag_kind() {
    let reply = reply_with(&false);
    for kind in [
        WriteKind::DoAction,
        WriteKind::SelectChild,
        WriteKind::ClearSelection,
        WriteKind::ScrollTo,
        WriteKind::InsertText,
        WriteKind::DeleteText,
        WriteKind::SetTextContents,
    ] {
        assert_eq!(
            read_reply(&reply, kind).expect("a flag"),
            WriteReply::Absent
        );
    }
}

#[test]
fn a_true_return_is_delivered_with_the_effect_unobserved() {
    let reply = reply_with(&true);
    assert_eq!(
        read_reply(&reply, WriteKind::DoAction).expect("a flag"),
        WriteReply::Done
    );
}

#[test]
fn a_property_write_has_no_flag_to_read() {
    let reply = reply_with(&());
    assert_eq!(
        read_reply(&reply, WriteKind::SetProperty).expect("no flag"),
        WriteReply::Done
    );
}

#[test]
fn a_return_that_is_not_a_flag_is_uncertain_after_the_write_ran() {
    let reply = reply_with(&"not a flag");
    let error = read_reply(&reply, WriteKind::DoAction).expect_err("a body of the wrong type");
    assert_eq!(error.code, ErrorCode::ActionFailed);
    assert_eq!(
        error.disposition.delivery(),
        DeliveryDisposition::DeliveryUncertain
    );
}

#[test]
fn a_deadline_spent_before_the_message_leaves_is_not_delivered() {
    let bus = SharedBus::default();
    let element = AtspiElement::new(":1.1", "/p", 1);
    let handle = NativeHandle::new(element.clone());
    let deadline = Deadline::after(1).expect("a deadline builds");
    std::thread::sleep(Duration::from_millis(10));
    let target = Target {
        bus: &bus,
        handle: &handle,
        element: &element,
        deadline,
    };
    let error = invoke(
        &target,
        Call {
            interface: "org.a11y.atspi.Action",
            method: "DoAction",
            body: &(0i32,),
            kind: WriteKind::DoAction,
        },
    )
    .expect_err("no budget is left");
    assert_eq!(error.code, ErrorCode::Timeout);
    assert_eq!(
        error.disposition.delivery(),
        DeliveryDisposition::NotDelivered
    );
}
