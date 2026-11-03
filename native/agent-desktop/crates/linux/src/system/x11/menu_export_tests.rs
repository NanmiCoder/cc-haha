use super::{decode, text};
use x11rb::protocol::xproto::GetPropertyReply;

#[test]
fn exported_text_rejects_wrong_type_width_truncation_and_invalid_utf8() {
    let reply = GetPropertyReply {
        format: 8,
        sequence: 0,
        length: 1,
        type_: 17,
        bytes_after: 0,
        value_len: 4,
        value: b":1.2".to_vec(),
    };
    assert_eq!(text(reply.clone(), 17).as_deref(), Some(":1.2"));
    assert!(text(reply.clone(), 18).is_none());
    for bad in [
        GetPropertyReply {
            format: 32,
            ..reply.clone()
        },
        GetPropertyReply {
            bytes_after: 4,
            ..reply.clone()
        },
        GetPropertyReply {
            value: vec![255],
            ..reply.clone()
        },
        GetPropertyReply {
            value: Vec::new(),
            ..reply
        },
    ] {
        assert!(text(bad, 17).is_none());
    }
}

#[test]
fn exported_binding_requires_unique_bus_and_valid_object_paths() {
    let valid = [":1.42", "/app", "/app/window/1", "/app/menubar"].map(str::to_owned);
    let export = decode(valid.clone()).unwrap();
    assert_eq!(export.bus_name, ":1.42");
    assert_eq!(export.application_path, "/app");
    assert_eq!(export.window_path, "/app/window/1");
    assert_eq!(export.menubar_path, "/app/menubar");
    for (index, value) in [
        (0, "org.example.App"),
        (1, "app"),
        (2, "/bad-path"),
        (3, ""),
    ] {
        let mut invalid = valid.clone();
        invalid[index] = value.into();
        assert!(decode(invalid).is_none());
    }
}
