use super::reads_x11;
use crate::system::display::display_cause::Cause;
use crate::system::display::display_server::DisplayServer;
use crate::system::display::display_unavailable::Unavailable;

#[test]
fn an_unreachable_display_is_reported_as_the_display_when_listing_windows() {
    let error = reads_x11(DisplayServer::Unavailable(Unavailable {
        cause: Cause::Missing,
        detail: "DISPLAY=:999 names a server that is not running".to_owned(),
    }))
    .expect_err("an unreachable display is not read");
    assert_eq!(
        error.code,
        agent_desktop_core::ErrorCode::PlatformNotSupported
    );
    assert!(!reads_x11(DisplayServer::Wayland).unwrap());
    assert!(reads_x11(DisplayServer::X11(":1".into())).unwrap());
}
