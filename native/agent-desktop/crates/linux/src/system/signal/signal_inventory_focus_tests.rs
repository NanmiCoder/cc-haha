use super::*;

#[test]
fn one_active_candidate_without_x11_evidence_is_the_focused_window() {
    let registry = registry(vec![app(":1.1", 1, "alpha", true)]);
    let frames = vec![read(
        vec![
            frame(":1.1", "/org/a11y/atspi/accessible/1", 1, &[25, 1]),
            frame(":1.1", "/org/a11y/atspi/accessible/2", 1, &[25]),
        ],
        RootRead::Read,
    )];
    let (windows, outcomes, _) = gathered(&registry, |_| true, frames);
    let pass = pass_over(windows, outcomes, Vec::new(), &X11State::Unavailable);
    assert_eq!(pass.candidates, [0]);
    assert_eq!(pass.focused, Some(0));
}

#[test]
fn two_active_candidates_without_x11_evidence_name_no_focused_window() {
    let registry = registry(vec![app(":1.1", 1, "alpha", true)]);
    let frames = vec![read(
        vec![
            frame(":1.1", "/org/a11y/atspi/accessible/1", 1, &[25, 1]),
            frame(":1.1", "/org/a11y/atspi/accessible/2", 1, &[25, 1]),
        ],
        RootRead::Read,
    )];
    let (windows, outcomes, _) = gathered(&registry, |_| true, frames);
    let pass = pass_over(windows, outcomes, Vec::new(), &X11State::Unavailable);
    assert_eq!(pass.candidates, [0, 1]);
    assert_eq!(pass.focused, None);
}

#[test]
fn an_active_window_no_client_claims_is_not_a_candidate() {
    use crate::system::x11::X11Client;
    let registry = registry(vec![app(":1.1", 1, "alpha", true)]);
    let frames = vec![read(
        vec![
            frame(":1.1", "/org/a11y/atspi/accessible/1", 1, &[25, 1]),
            frame(":1.1", "/org/a11y/atspi/accessible/2", 1, &[25]),
        ],
        RootRead::Read,
    )];
    let (windows, outcomes, _) = gathered(&registry, |_| true, frames);
    let clients = vec![X11Client {
        id: 0x40_0003,
        pid: Some(1),
        title: "other".to_owned(),
        extents: None,
        bounds: None,
        hidden: false,
        shadow: (0, 0, 0, 0),
    }];
    let state = X11State::Ready {
        active: None,
        clients,
    };
    let pass = pass_over(windows, outcomes, Vec::new(), &state);
    assert!(pass.candidates.is_empty());
    assert_eq!(pass.focused, None);
}

#[test]
fn the_app_the_manager_names_active_owns_the_focus_when_its_menu_is_open() {
    let (windows, outcomes, state) = menu_desktop();
    assert_eq!(
        pass_over(windows, outcomes, Vec::new(), &state).focused,
        None,
        "no frame claims ACTIVE while the menu's grab holds the keyboard"
    );

    let (windows, outcomes, state) = menu_desktop();
    let pass = pass_over_with_menu(
        windows,
        outcomes,
        Vec::new(),
        &state,
        |_| Ok(true),
        |_| false,
    );
    assert_eq!(pass.focused, Some(0));

    let (windows, outcomes, state) = menu_desktop();
    let closed = pass_over_with_menu(
        windows,
        outcomes,
        Vec::new(),
        &state,
        |_| Ok(false),
        |_| false,
    );
    assert_eq!(closed.focused, None);
}

#[test]
fn an_active_window_with_a_client_keeps_its_candidacy() {
    use crate::system::x11::X11Client;
    use crate::tree::Extents;
    let registry = registry(vec![app(":1.1", 1, "alpha", true)]);
    let frames = vec![read(
        vec![
            frame(":1.1", "/org/a11y/atspi/accessible/1", 1, &[25, 1]),
            frame(":1.1", "/org/a11y/atspi/accessible/2", 1, &[25]),
        ],
        RootRead::Read,
    )];
    let (windows, outcomes, _) = gathered(&registry, |_| true, frames);
    let title = windows[0].frame.title.clone();
    let clients = vec![X11Client {
        id: 0x40_0003,
        pid: Some(1),
        title,
        extents: None,
        bounds: Some(Extents {
            x: 0,
            y: 0,
            width: 10,
            height: 10,
        }),
        hidden: false,
        shadow: (0, 0, 0, 0),
    }];
    let state = X11State::Ready {
        active: Some(0x40_0003),
        clients,
    };
    let pass = pass_over(windows, outcomes, Vec::new(), &state);
    assert_eq!(pass.candidates, [0]);
    assert_eq!(pass.focused, Some(0));
}
