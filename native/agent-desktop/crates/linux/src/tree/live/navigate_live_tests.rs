use std::time::Duration;

use agent_desktop_core::RefEntry;

use super::live_launch::{nonce, program_of};
use super::live_rig::{deadline, kind, refused, rig, signal, wait_until};
use super::live_tree::{frames_where, pid_frame};
use super::walker_live_tests::{settle, settle_watching};

fn entry_named(entries: &[(String, RefEntry)], role: &str, name: Option<&str>) -> RefEntry {
    entries
        .iter()
        .map(|(_, entry)| entry)
        .find(|entry| entry.identity.role == role && entry.identity.name.as_deref() == name)
        .unwrap_or_else(|| panic!("no {role} named {name:?}"))
        .clone()
}

#[test]
#[ignore = "drives a real desktop application; run through scripts/private-session.sh"]
fn navigate_live_a_settings_panel_ref_is_stale_after_another_panel_replaces_it() {
    let mut rig = rig();
    let pid = rig.launched.spawn("gnome-control-center", &["network"]);
    let settled = rig.settled(pid, 20);
    let entries = rig.entries(&settled.frame, true);
    let panel_a = entry_named(&entries, "button", Some("Add Ethernet Connection"));
    let sidebar_row = entry_named(&entries, "button", Some("Network"));
    let categories = entry_named(&entries, "listbox", Some("Settings categories"));
    rig.resolve(&panel_a).expect("the panel control resolves");
    rig.resolve(&categories)
        .expect("the category list resolves");

    rig.launched.spawn("gnome-control-center", &["sound"]);
    assert!(
        wait_until(Duration::from_secs(8), || rig.resolve(&panel_a).is_err()),
        "the replaced panel's control stops resolving"
    );
    let error = refused(rig.resolve(&panel_a), "the replaced panel");
    println!(
        "navigate_live settings: panel A {:?} kind {}",
        error.code,
        kind(&error)
    );
    assert_eq!(error.code, agent_desktop_core::ErrorCode::StaleRef);
    assert_eq!(
        error.is_explicitly_retryable(),
        kind(&error) == "resolve_no_candidate"
    );
    assert!(
        rig.resolve(&sidebar_row).is_ok(),
        "the sidebar row is untouched"
    );
}

#[test]
#[ignore = "drives a real desktop application; run through scripts/private-session.sh"]
fn navigate_live_every_ref_of_a_relaunched_app_is_stale_through_the_gate() {
    let mut rig = rig();
    let first = rig.launched.spawn("gnome-calculator", &[]);
    let settled = rig.settled(first, 30);
    let entries = rig.entries(&settled.frame, true);
    let resolving = entries
        .iter()
        .filter(|(_, entry)| rig.resolve(entry).is_ok())
        .count();
    assert!(
        resolving + 2 >= entries.len() && resolving > 0,
        "{resolving} of {} refs resolve while the app lives",
        entries.len()
    );
    signal(first, "KILL");
    let second = rig.launched.spawn("gnome-calculator", &[]);
    let connection = rig.bus.get(deadline(5_000)).expect("the bus");
    settle_watching(&rig.bus, 30, Some(second), || {
        pid_frame(&connection, second)
    })
    .unwrap_or_else(|error| panic!("the new app settles: {error}"));
    let mut kinds = std::collections::BTreeSet::new();
    for (id, entry) in &entries {
        let error = refused(
            rig.resolve(entry),
            &format!("{id} resolved across a relaunch"),
        );
        assert_eq!(error.code, agent_desktop_core::ErrorCode::StaleRef, "{id}");
        assert_eq!(
            error.is_explicitly_retryable(),
            kind(&error) == "resolve_no_candidate",
            "{id}"
        );
        kinds.insert(kind(&error));
    }
    println!(
        "navigate_live relaunch: {} refs, all stale, kinds {kinds:?}",
        entries.len()
    );
}

#[test]
#[ignore = "drives a real desktop application; run through scripts/private-session.sh"]
fn navigate_live_closing_one_files_window_leaves_its_refs_stale_and_the_other_window_resolving() {
    let mut rig = rig();
    let directory = std::env::temp_dir().join(nonce("files"));
    std::fs::create_dir_all(&directory).expect("a directory");
    rig.launched.scratch.push(directory.clone());
    let path = directory.to_string_lossy().into_owned();
    let first = rig.launched.spawn("nautilus", &["--new-window", &path]);
    let connection = rig.bus.get(deadline(5_000)).expect("the bus");
    let is_files = |pid: u32| program_of(pid).as_deref() == Some("nautilus");
    let one = settle(&rig.bus, 30, || {
        frames_where(&connection, is_files).into_iter().next()
    })
    .expect("the first window settles");
    rig.launched.spawn("nautilus", &["--new-window", &path]);
    assert!(
        wait_until(Duration::from_secs(40), || {
            frames_where(&connection, is_files).len() >= 2
        }),
        "a second Files window opens (first launched pid {first})"
    );
    let frames = frames_where(&connection, is_files);
    let other = frames
        .iter()
        .find(|frame| frame.path() != one.frame.path() || frame.bus_name() != one.frame.bus_name())
        .expect("another window")
        .clone();
    let second = settle(&rig.bus, 30, || Some(other.clone())).expect("the second settles");
    let in_first = rig.entries(&one.frame, true);
    let in_second = rig.entries(&second.frame, true);
    let close = entry_named(&in_first, "button", Some("Close"));
    let handle = rig.resolve(&close).expect("the Close button resolves");
    rig.do_action(&handle, 0).expect("Close is pressed");
    assert!(
        wait_until(Duration::from_secs(10), || rig.resolve(&close).is_err()),
        "the closed window's refs stop resolving"
    );
    let error = refused(rig.resolve(&close), "the closed window");
    println!(
        "navigate_live close: {:?} kind {}",
        error.code,
        kind(&error)
    );
    assert_eq!(error.code, agent_desktop_core::ErrorCode::StaleRef);
    assert_eq!(
        error.is_explicitly_retryable(),
        kind(&error) == "resolve_no_candidate"
    );
    let survivor = in_second
        .iter()
        .find(|(_, entry)| entry.identity.role == "button")
        .expect("a button in the other window");
    assert!(rig.resolve(&survivor.1).is_ok());
}
