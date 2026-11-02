use super::*;

#[test]
fn session_bus_errors_keep_their_platform_and_retry_meaning() {
    let refused = zbus::Error::InputOutput(std::sync::Arc::new(std::io::Error::from(
        ErrorKind::NotFound,
    )));
    let error = unreachable(&refused);
    assert_eq!(error.code, ErrorCode::PlatformNotSupported);
    assert!(error.message.contains("session bus"));
    assert!(!error.message.contains("AT-SPI"));

    let slow = zbus::Error::InputOutput(std::sync::Arc::new(std::io::Error::from(
        ErrorKind::TimedOut,
    )));
    assert_eq!(unreachable(&slow).code, ErrorCode::Timeout);

    let broken = zbus::Error::InputOutput(std::sync::Arc::new(std::io::Error::from(
        ErrorKind::BrokenPipe,
    )));
    assert!(is_transport_failure(&broken));
    let refused = zbus::Error::Failure("no".into());
    assert!(!is_transport_failure(&refused));
}
