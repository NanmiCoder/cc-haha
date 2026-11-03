use agent_desktop_core::{WindowInfo, WindowState};

use super::*;
use crate::system::x11::{FrameFacts, X11Client};

fn listed(pid: u32, title: &str, active: bool) -> ListedWindow {
    ListedWindow {
        app: 0,
        info: WindowInfo {
            id: format!("w-{pid}-{title}-{active}"),
            title: title.to_owned(),
            app: "editor".to_owned(),
            pid: pid.into(),
            process_instance: None,
            bounds: None,
            state: WindowState::default(),
        },
        active,
        modal: false,
        dialog: false,
        frame: FrameFacts {
            size_identity: false,
            pid,
            title: title.to_owned(),
            extents: None,
            global_position: false,
        },
        sheet: false,
        unshown: false,
    }
}

fn client(id: u32, pid: u32, title: &str) -> X11Client {
    X11Client {
        shadow: (0, 0, 0, 0),
        id,
        hidden: false,
        pid: Some(pid),
        title: title.to_owned(),
        extents: None,
        bounds: None,
    }
}

fn state(active: Option<u32>) -> X11State {
    X11State::Ready {
        active,
        clients: vec![
            client(7, 1, "Doc"),
            client(8, 1, "Doc"),
            client(9, 1, "Other"),
            client(10, 2, "Doc"),
        ],
    }
}

#[test]
fn only_windows_of_one_process_and_title_are_twins() {
    let windows = [
        listed(1, "Doc", false),
        listed(2, "Doc", true),
        listed(1, "Doc", true),
        listed(1, "Other", false),
    ];
    let twins = twins_of(&windows, 2).expect("the window is listed");
    assert_eq!(twins.active, vec![false, true]);
    assert_eq!(twins.me, 1);
    assert_eq!(twins_of(&windows, 9), None);
}

#[test]
fn each_of_two_twins_takes_its_own_client_and_a_stranger_is_untouched() {
    let windows = [
        listed(1, "Doc", false),
        listed(1, "Doc", true),
        listed(1, "Other", false),
        listed(2, "Doc", false),
    ];
    let state = state(Some(8));
    assert_eq!(listed_client(&windows, 0, &state), ClientMatch::One(7));
    assert_eq!(listed_client(&windows, 1, &state), ClientMatch::One(8));
    assert_eq!(listed_client(&windows, 2, &state), ClientMatch::One(9));
    assert_eq!(listed_client(&windows, 3, &state), ClientMatch::One(10));
}

#[test]
fn twins_the_manager_does_not_separate_stay_tied() {
    let windows = [listed(1, "Doc", false), listed(1, "Doc", true)];
    for active in [None, Some(9), Some(10)] {
        assert_eq!(
            listed_client(&windows, 0, &state(active)),
            ClientMatch::Several(vec![7, 8])
        );
    }
}

#[test]
fn a_session_without_clients_maps_nothing() {
    let windows = [listed(1, "Doc", true)];
    for state in [X11State::Unavailable, X11State::NoWindowManager] {
        assert_eq!(listed_client(&windows, 0, &state), ClientMatch::NoClient);
    }
}
