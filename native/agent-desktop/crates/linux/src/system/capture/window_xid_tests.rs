use super::*;
use crate::system::x11::X11Client;
use crate::tree::Extents;
use agent_desktop_core::WindowState;

fn frame(pid: u32, title: &str) -> FrameFacts {
    FrameFacts {
        size_identity: false,
        pid,
        title: title.to_owned(),
        extents: None,
        global_position: false,
    }
}

fn client(id: u32, pid: u32, title: &str) -> X11Client {
    X11Client {
        id,
        pid: Some(pid),
        title: title.to_owned(),
        extents: None,
        bounds: Some(Extents {
            x: 0,
            y: 0,
            width: 10,
            height: 10,
        }),
        hidden: false,
        shadow: (0, 0, 0, 0),
    }
}

fn ready(clients: Vec<X11Client>) -> X11State {
    X11State::Ready {
        active: None,
        clients,
    }
}

#[test]
fn one_matching_client_is_its_id() {
    let state = ready(vec![client(7, 1, "A"), client(8, 1, "B")]);
    assert_eq!(outcome_of(state, &frame(1, "B")), XidOutcome::One(8));
}

#[test]
fn two_matching_clients_are_several() {
    let state = ready(vec![client(7, 1, "A"), client(8, 1, "A")]);
    assert_eq!(
        outcome_of(state, &frame(1, "A")),
        XidOutcome::Several(vec![7, 8])
    );
}

#[test]
fn no_matching_client_with_a_manager_is_no_client() {
    let state = ready(vec![client(7, 2, "A")]);
    assert_eq!(outcome_of(state, &frame(1, "A")), XidOutcome::NoClient);
}

#[test]
fn the_server_states_without_a_client_list_keep_their_cause() {
    assert_eq!(
        outcome_of(X11State::NoWindowManager, &frame(1, "A")),
        XidOutcome::NoManager
    );
    assert_eq!(
        outcome_of(X11State::Unavailable, &frame(1, "A")),
        XidOutcome::Unavailable
    );
}

fn listed(id: &str, title: &str, active: bool) -> ListedWindow {
    ListedWindow {
        app: 0,
        info: WindowInfo {
            id: id.to_owned(),
            title: title.to_owned(),
            app: "editor".to_owned(),
            pid: 1.into(),
            process_instance: None,
            bounds: None,
            state: WindowState::default(),
        },
        active,
        modal: false,
        dialog: false,
        frame: frame(1, title),
        sheet: false,
        unshown: false,
    }
}

fn twins_with_active(active: Option<u32>) -> X11State {
    X11State::Ready {
        active,
        clients: vec![
            client(7, 1, "Doc"),
            client(8, 1, "Doc"),
            client(9, 1, "Other"),
        ],
    }
}

#[test]
fn two_windows_of_one_title_each_take_their_own_client_by_the_active_one() {
    let windows = [
        listed("w-a", "Doc", false),
        listed("w-b", "Doc", true),
        listed("w-c", "Other", false),
    ];
    let state = twins_with_active(Some(8));
    assert_eq!(
        settled(&state, &windows, &windows[0].info),
        XidOutcome::One(7)
    );
    assert_eq!(
        settled(&state, &windows, &windows[1].info),
        XidOutcome::One(8)
    );
    assert_eq!(
        settled(&state, &windows, &windows[2].info),
        XidOutcome::One(9)
    );
}

#[test]
fn twin_windows_stay_several_when_the_manager_names_no_client_of_theirs() {
    let windows = [listed("w-a", "Doc", false), listed("w-b", "Doc", true)];
    for active in [None, Some(9)] {
        assert_eq!(
            settled(&twins_with_active(active), &windows, &windows[0].info),
            XidOutcome::Several(vec![7, 8])
        );
    }
}
