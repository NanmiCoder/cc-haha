use agent_desktop_core::{WindowInfo, WindowState};

use super::without_ghosts;
use crate::system::registry::listed_window::ListedWindow;
use crate::system::x11::{FrameFacts, X11Client, X11State};

fn window(id: &str, title: &str, unshown: bool) -> ListedWindow {
    ListedWindow {
        app: 0,
        info: WindowInfo {
            id: id.to_owned(),
            title: title.to_owned(),
            app: "qt".to_owned(),
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
            title: title.to_owned(),
            extents: None,
            global_position: false,
        },
        sheet: false,
        unshown,
    }
}

fn client(id: u32, title: &str, hidden: bool) -> X11Client {
    X11Client {
        id,
        pid: Some(7),
        title: title.to_owned(),
        extents: None,
        bounds: None,
        hidden,
        shadow: (0, 0, 0, 0),
    }
}

fn ready(clients: Vec<X11Client>) -> X11State {
    X11State::Ready {
        active: None,
        clients,
    }
}

fn ids(windows: &[ListedWindow]) -> Vec<&str> {
    windows
        .iter()
        .map(|window| window.info.id.as_str())
        .collect()
}

#[test]
fn a_window_with_states_is_never_dropped() {
    let kept = without_ghosts(vec![window("w-1", "main", false)], &X11State::Unavailable);
    assert_eq!(ids(&kept), ["w-1"]);
}

#[test]
fn a_hidden_dialog_without_a_client_is_dropped() {
    let state = ready(vec![client(10, "main", false)]);
    let kept = without_ghosts(
        vec![window("w-1", "main", false), window("w-2", "dlg", true)],
        &state,
    );
    assert_eq!(ids(&kept), ["w-1"]);
}

#[test]
fn a_unshown_window_is_dropped_where_the_display_server_cannot_say() {
    for state in [X11State::Unavailable, X11State::NoWindowManager] {
        let kept = without_ghosts(vec![window("w-2", "dlg", true)], &state);
        assert!(kept.is_empty(), "{state:?}");
    }
}

#[test]
fn a_minimized_window_the_manager_still_manages_is_kept() {
    let state = ready(vec![client(10, "main", true)]);
    let kept = without_ghosts(vec![window("w-1", "main", true)], &state);
    assert_eq!(ids(&kept), ["w-1"]);
}

#[test]
fn the_husk_of_a_reopened_dialog_is_dropped_and_the_live_one_stays() {
    let state = ready(vec![client(11, "dlg", false)]);
    let kept = without_ghosts(
        vec![window("w-old", "dlg", true), window("w-new", "dlg", false)],
        &state,
    );
    assert_eq!(ids(&kept), ["w-new"]);
}

#[test]
fn a_closed_dialog_with_a_blank_name_is_dropped() {
    let state = ready(vec![client(10, "main", false)]);
    let kept = without_ghosts(vec![window("w-2", "", true)], &state);
    assert!(kept.is_empty());
}
