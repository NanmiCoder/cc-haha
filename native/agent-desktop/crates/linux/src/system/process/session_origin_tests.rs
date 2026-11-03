use super::*;

#[test]
fn a_service_unit_below_the_user_manager_is_a_session_service() {
    assert!(is_user_service_unit(
        "/user.slice/user-1000.slice/user@1000.service/app.slice/xdg-desktop-portal-gtk.service"
    ));
    assert!(is_user_service_unit(
        "/user.slice/user-1000.slice/user@1000.service/session.slice/org.gnome.Shell@x11.service"
    ));
}

#[test]
fn a_launched_scope_or_a_login_session_is_not_a_session_service() {
    assert!(!is_user_service_unit(
        "/user.slice/user-1000.slice/user@1000.service/app.slice/app-gnome-calculator-42.scope"
    ));
    assert!(!is_user_service_unit(
        "/user.slice/user-1000.slice/session-3.scope"
    ));
    assert!(!is_user_service_unit(
        "/user.slice/user-1000.slice/user@1000.service"
    ));
    assert!(!is_user_service_unit("/system.slice/cron.service"));
    assert!(!is_user_service_unit(""));
}

#[test]
fn the_launch_marker_is_read_from_a_process_environment() {
    assert!(has_launch_marker(
        b"HOME=/h\0AGENT_DESKTOP_LAUNCHED=1\0PATH=/bin\0"
    ));
    assert!(!has_launch_marker(
        b"HOME=/h\0NOT_AGENT_DESKTOP_LAUNCHED=1\0"
    ));
    assert!(!has_launch_marker(b""));
}

#[test]
fn a_child_started_with_the_marker_is_launched_by_the_agent() {
    let spawn = |marked: bool| {
        let mut command = std::process::Command::new("/bin/sleep");
        command.arg("30");
        if marked {
            command.env(LAUNCH_MARKER, "1");
        } else {
            command.env_remove(LAUNCH_MARKER);
        }
        command.spawn().unwrap()
    };
    let (mut marked, mut plain) = (spawn(true), spawn(false));
    let verdicts = (
        launched_by_agent(marked.id()),
        launched_by_agent(plain.id()),
    );
    for child in [&mut marked, &mut plain] {
        child.kill().unwrap();
        child.wait().unwrap();
    }
    assert!(verdicts.0.unwrap());
    assert!(!verdicts.1.unwrap());
}

fn no() -> Result<bool, AdapterError> {
    Ok(false)
}

fn yes() -> Result<bool, AdapterError> {
    Ok(true)
}

#[test]
fn each_kind_of_session_evidence_protects_an_unlaunched_windowless_process() {
    assert!(is_session_service(no, || false, yes, no, no).unwrap());
    assert!(is_session_service(no, || false, no, yes, no).unwrap());
    assert!(is_session_service(no, || false, no, no, yes).unwrap());
    assert!(!is_session_service(no, || false, no, no, no).unwrap());
}

#[test]
fn a_launched_or_windowed_process_is_never_a_session_service() {
    assert!(!is_session_service(yes, || false, yes, yes, yes).unwrap());
    assert!(!is_session_service(no, || true, yes, yes, yes).unwrap());
}

#[test]
fn evidence_that_cannot_be_read_refuses_instead_of_clearing() {
    let unreadable = || Err(unknown());
    assert!(is_session_service(unreadable, || false, no, no, no).is_err());
    assert!(is_session_service(no, || false, unreadable, no, no).is_err());
    assert!(is_session_service(no, || false, no, no, unreadable).is_err());
}

#[test]
fn a_process_whose_parent_is_the_display_owner_is_a_compositor_child() {
    let mut child = std::process::Command::new("/bin/sleep")
        .arg("30")
        .spawn()
        .unwrap();
    let parent = std::process::id();
    let yes_for_parent = child_of_display_owner(child.id(), |pid| Ok(pid == parent));
    let no_for_other = child_of_display_owner(child.id(), |_| Ok(false));
    child.kill().unwrap();
    child.wait().unwrap();
    assert!(yes_for_parent.unwrap());
    assert!(!no_for_other.unwrap());
}

#[test]
fn the_display_owner_and_its_children_are_on_its_side_and_other_processes_are_not() {
    let mut child = std::process::Command::new("/bin/sleep")
        .arg("30")
        .spawn()
        .unwrap();
    let parent = std::process::id();
    let own_pid = child.id();
    let is_owner = |owner: u32| move |pid: u32| Ok(pid == owner);
    let itself = on_display_owner_side(own_pid, is_owner(own_pid));
    let as_child = on_display_owner_side(own_pid, is_owner(parent));
    let stranger = on_display_owner_side(own_pid, is_owner(1));
    child.kill().unwrap();
    child.wait().unwrap();
    assert!(itself.unwrap());
    assert!(as_child.unwrap());
    assert!(!stranger.unwrap());
}
