use agent_desktop_core::Deadline;

use super::display_server::{DisplayServer, session_server};
use crate::system::display::list_displays;

#[test]
#[ignore = "needs a private X session; run through scripts/private-session.sh"]
fn display_live_lists_the_private_screen_even_with_a_stale_wayland_variable() {
    let stale = std::env::var("WAYLAND_DISPLAY").ok();
    let server = session_server();
    println!("display_live WAYLAND_DISPLAY={stale:?} server={server:?}");
    assert!(matches!(server, DisplayServer::X11(_)));
    let displays = list_displays(Deadline::after(10_000).expect("a deadline builds"))
        .expect("the X11 monitor list reads");
    let [display] = displays.as_slice() else {
        panic!("the private session has one screen: {displays:?}")
    };
    println!("display_live display={display:?}");
    assert!(display.is_primary);
    assert_eq!(
        (display.bounds.width, display.bounds.height),
        (1280.0, 800.0)
    );
}
