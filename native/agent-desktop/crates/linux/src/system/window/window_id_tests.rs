use agent_desktop_core::ErrorCode;

use super::{decode, encode};

const GTK_PATH: &str = "/org/gnome/Calculator/a11y/0e38ec41_eddb_4179_b361_673b342c2260";
const QT_PATH: &str = "/org/a11y/atspi/accessible/2147483649";
const CHROMIUM_PATH: &str = "/org/a11y/atspi/accessible/1";
const UNUSUAL_PATH: &str = "/Some/Other_Root/frame7";

#[test]
fn ids_round_trip_for_every_recorded_path_shape() {
    for path in [GTK_PATH, QT_PATH, CHROMIUM_PATH, UNUSUAL_PATH] {
        let id = encode(":1.42", path).expect("a unique name and a valid path encode");
        assert_eq!(
            decode(&id).expect("its own id decodes"),
            (":1.42".to_owned(), path.to_owned())
        );
    }
}

#[test]
fn an_id_is_made_of_shell_safe_characters() {
    let id = encode(":1.42", GTK_PATH).expect("encodes");
    assert!(
        id.bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_')),
        "{id}"
    );
}

#[test]
fn a_bus_name_or_path_the_bus_cannot_have_issued_does_not_encode() {
    assert_eq!(encode("org.example.App", CHROMIUM_PATH), None);
    assert_eq!(encode(":1", CHROMIUM_PATH), None);
    assert_eq!(encode(":1.x", CHROMIUM_PATH), None);
    assert_eq!(encode(":1.42", "relative/path"), None);
    assert_eq!(encode(":1.42", "/"), None);
    assert_eq!(encode(":1.42", "/a//b"), None);
    assert_eq!(encode(":1.42", "/a-b"), None);
}

#[test]
fn anything_but_its_own_format_is_invalid_args() {
    for id in [
        "",
        "w-",
        "w-1.42",
        "w-1.42-",
        "w-1.42--a",
        "w-x.y-a",
        "w-1.42-a-",
        "x-1.42-a",
        "12345",
        "w-1.42-a/b",
        "w-1.42-a b",
        "@s8f3k2p9:e1",
    ] {
        let error = decode(id).expect_err(id);
        assert_eq!(error.code, ErrorCode::InvalidArgs, "{id}");
    }
}
