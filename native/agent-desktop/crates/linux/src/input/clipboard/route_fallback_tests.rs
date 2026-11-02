use agent_desktop_core::{
    ClipboardContent, ClipboardFormat, Deadline, ErrorCode, InteractionLease,
};

use super::ClipboardTools;
use crate::input::clipboard::set_clear::{clear_from, get_from, set_from};
use crate::system::display::display_server::DisplayServer;

#[test]
fn missing_wayland_tools_never_redirect_clipboard_to_x11() {
    let tools = ClipboardTools {
        search_path: Some("/nonexistent/ad-tools".into()),
    };
    let deadline = Deadline::after(1_000).expect("deadline");
    let lease = InteractionLease::guarded(deadline, ()).expect("lease");
    let errors = [
        get_from(
            DisplayServer::Wayland,
            &tools,
            ClipboardFormat::Text,
            deadline,
        )
        .expect_err("missing tool"),
        set_from(
            DisplayServer::Wayland,
            &tools,
            &ClipboardContent::Text("hello".into()),
            &lease,
        )
        .expect_err("missing tool"),
        clear_from(DisplayServer::Wayland, &tools, &lease).expect_err("missing tool"),
    ];
    for error in errors {
        assert_eq!(error.code, ErrorCode::PlatformNotSupported);
        assert!(
            error
                .suggestion
                .expect("install guidance")
                .contains("wl-clipboard")
        );
    }
}
