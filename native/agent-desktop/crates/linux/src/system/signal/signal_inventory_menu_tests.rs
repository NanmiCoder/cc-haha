use super::*;

fn add_other_application(windows: &mut Vec<ListedWindow>, state: &mut X11State, active: bool) {
    let mut other = windows[0].clone();
    other.app = 1;
    other.active = active;
    other.frame.pid = 2;
    other.info.pid = 2.into();
    other.info.app = "beta".into();
    other.info.id = "w-1.2-other".into();
    let X11State::Ready { clients, .. } = state else {
        panic!("the desktop has a window manager");
    };
    let mut client = clients[0].clone();
    client.id += 1;
    client.pid = Some(2);
    clients.push(client);
    windows.push(other);
}

#[test]
fn a_failed_menu_read_leaves_focus_incomplete() {
    let (windows, outcomes, state) = menu_desktop();
    let pass = pass_over_with_menu(
        windows,
        outcomes,
        Vec::new(),
        &state,
        |_| Err(AdapterError::timeout("The menu scan did not finish")),
        |_| false,
    );
    assert_eq!(pass.focused, None);
    assert!(!pass.menu_focus_complete);
    assert!(
        pass.outcomes
            .iter()
            .all(|outcome| outcome.read == RootRead::Read)
    );
}

#[test]
fn a_menu_does_not_override_a_conflicting_active_application() {
    let (mut windows, outcomes, mut state) = menu_desktop();
    add_other_application(&mut windows, &mut state, true);
    let pass = pass_over_with_menu(
        windows,
        outcomes,
        Vec::new(),
        &state,
        |_| Ok(true),
        |_| false,
    );
    assert_eq!(pass.candidates.len(), 1);
    assert_eq!(pass.focused, None);
}

#[test]
fn another_applications_menu_is_not_focus_for_the_active_application() {
    let (mut windows, outcomes, mut state) = menu_desktop();
    add_other_application(&mut windows, &mut state, false);
    let pass = pass_over_with_menu(
        windows,
        outcomes,
        Vec::new(),
        &state,
        |window| Ok(window.pid.get() == 2),
        |_| false,
    );
    assert_eq!(pass.focused, None);
    assert!(pass.menu_focus_complete);
}
