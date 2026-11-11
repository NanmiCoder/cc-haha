use agent_desktop_core::{Deadline, ErrorCode, WindowInfo, WindowState};

use super::without_helpers;
use crate::system::registry::listed_window::ListedWindow;
use crate::system::x11::FrameFacts;

#[test]
fn an_expired_window_read_is_timeout_instead_of_an_unsupported_surface() {
    let window = ListedWindow {
        app: 0,
        info: WindowInfo {
            id: "window".to_owned(),
            title: "Document".to_owned(),
            app: "App".to_owned(),
            pid: 7.into(),
            process_instance: Some("boot:7".to_owned()),
            bounds: None,
            state: WindowState::default(),
        },
        active: false,
        modal: false,
        dialog: false,
        frame: FrameFacts {
            size_identity: false,
            pid: 7,
            title: "Document".to_owned(),
            extents: None,
            global_position: false,
        },
        sheet: false,
        unshown: false,
    };
    let error = without_helpers(vec![window], Deadline::after(0).unwrap()).unwrap_err();
    assert_eq!(error.code, ErrorCode::Timeout);
}
