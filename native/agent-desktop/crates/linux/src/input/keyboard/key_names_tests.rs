use super::*;

#[test]
fn key_input_contract() {
    assert_eq!(keysym_for_key("a").unwrap(), 0x61);
    assert_eq!(keysym_for_key("A").unwrap(), 0x41);
    assert_eq!(keysym_for_key("PageDown").unwrap(), 0xff56);
    assert_eq!(keysym_for_key("greater").unwrap(), 0x3e);
    assert_eq!(keysym_for_key("Page_Up").unwrap(), 0xff55);
    assert_eq!(keysym_for_key("f24").unwrap(), 0xffd5);
    assert_eq!(keysym_for_key("forwarddelete").unwrap(), 0xffff);
    assert_eq!(keysym_for_key("delete").unwrap(), 0xff08);
    assert_eq!(keysym_for_key("\n").unwrap(), KEYSYM_RETURN);
    assert_eq!(keysym_for_key("\t").unwrap(), KEYSYM_TAB);
    assert_eq!(keysym_for_char('你'), 0x0100_4f60);

    for name in ["f0", "f01", "f25", "hyper", "cmd"] {
        let error = keysym_for_key(name).unwrap_err();
        assert_eq!(error.code, ErrorCode::InvalidArgs, "{name}");
        assert_eq!(error.disposition, DeliverySemantics::not_delivered());
        if name == "hyper" {
            assert!(error.suggestion.unwrap().contains("f1-f24"));
        }
    }
}
