use std::io::ErrorKind;
use std::sync::Arc;

use zbus::Message;

use super::*;

fn method_error(name: &str) -> zbus::Error {
    let call = Message::method_call("/probe", "Probe")
        .and_then(|builder| builder.build(&()))
        .expect("method call builds");
    let reply = Message::error(&call.header(), name)
        .and_then(|builder| builder.build(&()))
        .expect("error reply builds");
    zbus::Error::MethodError(name.try_into().expect("valid error name"), None, reply)
}

fn assert_not_delivered(error: &AdapterError, code: ErrorCode) {
    assert_eq!(error.code, code);
    assert_eq!(error.disposition, DeliverySemantics::not_delivered());
    assert_eq!(
        error.details.as_ref().expect("delivery details")["physical_delivery_started"],
        false
    );
}

#[test]
fn dbus_error_contract() {
    for name in [SERVICE_UNKNOWN, NAME_HAS_NO_OWNER, ACCESS_DENIED] {
        let error = classify_call(&method_error(name));
        assert_not_delivered(&error, ErrorCode::ActionNotSupported);
        assert!(error.message.contains("compositor"), "{name}");
    }

    let unknown = classify_call(&method_error("org.freedesktop.DBus.Error.UnknownMethod"));
    assert_eq!(unknown.code, ErrorCode::ActionFailed);
    assert!(
        unknown
            .platform_detail
            .is_some_and(|detail| detail.contains("org.freedesktop.DBus.Error.UnknownMethod"))
    );

    let timeout = zbus::Error::InputOutput(Arc::new(std::io::Error::from(ErrorKind::TimedOut)));
    assert_eq!(classify_call(&timeout).code, ErrorCode::Timeout);

    let creation_timeout = creation_failure(classify_call(&timeout));
    assert_not_delivered(&creation_timeout, ErrorCode::Timeout);

    let original_refusal = classify_call(&method_error(ACCESS_DENIED));
    let creation_refusal = creation_failure(original_refusal.clone());
    assert_not_delivered(&creation_refusal, ErrorCode::ActionNotSupported);
    assert_eq!(creation_refusal.message, original_refusal.message);
}
