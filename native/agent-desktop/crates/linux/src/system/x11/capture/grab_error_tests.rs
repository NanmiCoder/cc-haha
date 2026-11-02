use agent_desktop_core::{AdapterError, ErrorCode};
use x11rb::protocol::ErrorKind;

use super::*;

fn of(kind: ErrorKind, state: MapState) -> GrabError {
    GrabError::from_error_kind(kind, || state)
}

#[test]
fn each_protocol_error_maps_to_its_own_grab_error() {
    assert_eq!(of(ErrorKind::Window, MapState::Viewable), GrabError::Gone);
    assert_eq!(of(ErrorKind::Drawable, MapState::Viewable), GrabError::Gone);
    assert_eq!(
        of(ErrorKind::Alloc, MapState::Viewable),
        GrabError::Resource
    );
    assert_eq!(
        of(ErrorKind::Match, MapState::Unmapped),
        GrabError::Unviewable
    );
    assert_eq!(
        of(ErrorKind::Value, MapState::Viewable),
        GrabError::Fault(MonitorFault::Unreadable)
    );
}

#[test]
fn a_bad_match_on_a_viewable_window_is_off_screen_not_unviewable() {
    assert_eq!(
        of(ErrorKind::Match, MapState::Viewable),
        GrabError::OffScreen
    );
    assert_eq!(
        of(ErrorKind::Match, MapState::Unviewable),
        GrabError::Unviewable
    );
}

#[test]
fn the_map_state_is_read_only_for_a_bad_match() {
    let kind = ErrorKind::Window;
    let error = GrabError::from_error_kind(kind, || unreachable!("no map state read"));
    assert_eq!(error, GrabError::Gone);
}

#[test]
fn connection_faults_and_a_timeout_become_three_distinct_codes() {
    let unreachable: AdapterError =
        GrabError::Fault(MonitorFault::Unreachable(":77".to_owned())).into();
    let denied: AdapterError =
        GrabError::Fault(MonitorFault::Denied("no authority".to_owned())).into();
    let timeout: AdapterError = GrabError::Timeout.into();
    assert_eq!(unreachable.code, ErrorCode::PlatformNotSupported);
    assert!(unreachable.message.contains(":77"));
    assert_eq!(denied.code, ErrorCode::PlatformNotSupported);
    assert!(denied.message.contains("no authority"));
    assert!(denied.message.contains("refused"));
    assert!(!denied.message.contains("answers at"));
    assert_ne!(unreachable.message, denied.message);
    assert_eq!(timeout.code, ErrorCode::Timeout);
}
