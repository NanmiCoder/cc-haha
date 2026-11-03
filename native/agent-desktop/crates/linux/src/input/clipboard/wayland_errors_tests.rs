use super::*;

const NO_SOCKET: &str = "Failed to connect to a Wayland server: No such file or directory\nNote: WAYLAND_DISPLAY is set to wayland-nope\n";
const REFUSED: &str = "Failed to connect to a Wayland server: Connection refused\nNote: WAYLAND_DISPLAY is set to wayland-dead\n";

fn reason(error: &AdapterError) -> Option<String> {
    error
        .details
        .as_ref()
        .and_then(|details| details["reason"].as_str())
        .map(str::to_owned)
}

#[test]
fn the_measured_messages_are_told_apart() {
    assert_eq!(classify("Nothing is copied\n"), Failure::Empty);
    assert_eq!(classify("This seat has no keyboard\n"), Failure::NoKeyboard);
    assert_eq!(classify(NO_SOCKET), Failure::SocketMissing);
    assert_eq!(classify(REFUSED), Failure::SocketRefused);
    assert_eq!(
        classify("Clipboard content is not available as requested type \"image/png\"\n"),
        Failure::TypeUnavailable
    );
}

#[test]
fn a_message_nothing_explains_keeps_its_text() {
    assert_eq!(
        classify("  something new \n"),
        Failure::Other("something new".into())
    );
    assert_eq!(
        classify("Failed to connect to a Wayland server: Permission denied"),
        Failure::Other("Failed to connect to a Wayland server: Permission denied".into())
    );
}

#[test]
fn each_connection_failure_has_its_own_reason() {
    let unknown = DeliverySemantics::uncertain();
    let missing = failure_error(&Failure::SocketMissing, unknown);
    let refused = failure_error(&Failure::SocketRefused, unknown);
    assert_eq!(reason(&missing).as_deref(), Some("socket_missing"));
    assert_eq!(reason(&refused).as_deref(), Some("socket_refused"));
    assert_eq!(missing.code, ErrorCode::PlatformNotSupported);
}

#[test]
fn the_platform_detail_is_bounded() {
    let long = "x".repeat(5_000);
    let error = failure_error(&Failure::Other(long), DeliverySemantics::uncertain());
    assert_eq!(error.platform_detail.as_deref().map(str::len), Some(512));
}
