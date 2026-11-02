use agent_desktop_core::{WindowInfo, WindowState};

use super::front_to_back;
use crate::system::registry::listed_window::ListedWindow;
use crate::system::x11::{FrameFacts, X11Client, X11State};

fn window(title: &str, focused: bool) -> ListedWindow {
    ListedWindow {
        app: 0,
        info: WindowInfo {
            id: format!("w-{title}"),
            title: title.to_owned(),
            app: "editor".to_owned(),
            pid: 7.into(),
            process_instance: None,
            bounds: None,
            state: WindowState {
                is_focused: focused,
                ..WindowState::default()
            },
        },
        active: focused,
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
        unshown: false,
    }
}

fn client(id: u32, title: &str) -> X11Client {
    X11Client {
        id,
        pid: Some(7),
        title: title.to_owned(),
        extents: None,
        bounds: None,
        hidden: false,
        shadow: (0, 0, 0, 0),
    }
}

fn state(clients: &[(u32, &str)]) -> X11State {
    X11State::Ready {
        active: None,
        clients: clients
            .iter()
            .map(|(id, title)| client(*id, title))
            .collect(),
    }
}

fn titles(windows: &[ListedWindow]) -> Vec<&str> {
    windows
        .iter()
        .map(|window| window.info.title.as_str())
        .collect()
}

#[test]
fn the_focused_window_leads_and_the_rest_follow_the_stack_from_the_top() {
    let listed = vec![
        window("a", false),
        window("b", true),
        window("c", false),
        window("d", false),
    ];
    let state = state(&[(1, "a"), (2, "b"), (3, "c"), (4, "d")]);
    let ordered = front_to_back(listed, &state, Some(&[3, 1, 2, 4]));
    assert_eq!(titles(&ordered), ["b", "d", "a", "c"]);
}

#[test]
fn without_a_stacking_order_the_listing_order_follows_the_focused_window() {
    let listed = vec![window("a", false), window("b", false), window("c", true)];
    let state = state(&[(1, "a"), (2, "b"), (3, "c")]);
    assert_eq!(
        titles(&front_to_back(listed.clone(), &state, None)),
        ["c", "a", "b"]
    );
    assert_eq!(
        titles(&front_to_back(
            listed,
            &X11State::Unavailable,
            Some(&[3, 2, 1])
        )),
        ["c", "a", "b"]
    );
}

#[test]
fn a_window_without_a_single_client_follows_the_ranked_windows_in_listing_order() {
    let listed = vec![
        window("twin", false),
        window("a", false),
        window("b", false),
    ];
    let state = state(&[(1, "a"), (2, "b"), (3, "twin"), (4, "twin")]);
    let ordered = front_to_back(listed, &state, Some(&[3, 1, 4, 2]));
    assert_eq!(titles(&ordered), ["b", "a", "twin"]);
}

#[test]
fn a_focused_window_without_a_single_client_still_leads() {
    let listed = vec![window("a", false), window("twin", true), window("b", false)];
    let state = state(&[(1, "a"), (2, "b"), (3, "twin"), (4, "twin")]);
    let ordered = front_to_back(listed, &state, Some(&[3, 1, 4, 2]));
    assert_eq!(titles(&ordered), ["twin", "b", "a"]);
}

#[test]
fn same_title_windows_the_active_one_separates_rank_by_their_own_clients() {
    let listed = vec![
        window("twin", false),
        window("twin", true),
        window("a", false),
    ];
    let state = X11State::Ready {
        active: Some(4),
        clients: vec![client(1, "a"), client(3, "twin"), client(4, "twin")],
    };
    let ordered = front_to_back(listed, &state, Some(&[1, 3, 4]));
    let order: Vec<(&str, bool)> = ordered
        .iter()
        .map(|window| (window.info.title.as_str(), window.info.state.is_focused))
        .collect();
    assert_eq!(order, [("twin", true), ("twin", false), ("a", false)]);
}
