use super::*;

fn press(keysym: u32) -> KeysymStep {
    KeysymStep { keysym, down: true }
}

#[test]
fn one_unreachable_key_refuses_the_whole_sequence_before_any_send() {
    let keys = [press(0x68), press(0x0100_4f60), press(0x69), press(0x20ac)];
    let error = refuse_unreachable(&keys).expect_err("the sequence is refused");
    assert_eq!(error.code, ErrorCode::ActionNotSupported);
    assert_eq!(error.disposition, DeliverySemantics::not_delivered());
    let details = error.details.as_ref().expect("details");
    assert_eq!(details["physical_delivery_started"], false);
    assert_eq!(details["cause"], "character_outside_layout");
    assert!(
        error
            .suggestion
            .as_deref()
            .is_some_and(|text| text.contains("set-value"))
    );
    let rendered = format!("{error:?}");
    assert!(!rendered.contains("4f60") && !rendered.contains("你"));
}
