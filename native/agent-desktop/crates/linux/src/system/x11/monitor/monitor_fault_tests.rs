use x11rb::errors::ConnectError;
use x11rb::protocol::xproto::{SetupAuthenticate, SetupFailed};

use super::{MonitorFault, fault_of_connect};

#[test]
fn a_server_that_rejects_the_client_is_a_denial_carrying_its_reason() {
    let failed = ConnectError::SetupFailed(SetupFailed {
        status: 0,
        protocol_major_version: 11,
        protocol_minor_version: 0,
        length: 0,
        reason: b"Authorization required, but no authorization protocol specified\n".to_vec(),
    });
    assert_eq!(
        fault_of_connect(&failed),
        MonitorFault::Denied(
            "Authorization required, but no authorization protocol specified".to_owned()
        )
    );
    let authenticate = ConnectError::SetupAuthenticate(SetupAuthenticate {
        status: 2,
        reason: b"no".to_vec(),
    });
    assert_eq!(
        fault_of_connect(&authenticate),
        MonitorFault::Denied("no".to_owned())
    );
}

#[test]
fn an_address_nothing_answers_at_is_unreachable_and_a_garbled_handshake_is_unreadable() {
    let refused =
        ConnectError::IoError(std::io::Error::from(std::io::ErrorKind::ConnectionRefused));
    assert!(matches!(
        fault_of_connect(&refused),
        MonitorFault::Unreachable(_)
    ));
    assert!(matches!(
        fault_of_connect(&ConnectError::InvalidScreen),
        MonitorFault::Unreachable(_)
    ));
    assert_eq!(
        fault_of_connect(&ConnectError::ZeroIdMask),
        MonitorFault::Unreadable
    );
}
