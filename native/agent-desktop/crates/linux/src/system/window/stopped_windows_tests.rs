use super::of_stopped_apps;
use crate::system::process::process_facts::ProcessFacts;
use crate::system::process::toolkit_id::ToolkitId;
use crate::system::registry::Registry;
use crate::system::registry::registry_app::{RegistryApp, assemble};
use crate::system::window::window_id;
use crate::system::x11::{X11Client, X11State};
use crate::tree::{AtspiElement, Extents};

fn app(pid: u32, answered: bool) -> RegistryApp {
    assemble(
        AtspiElement::new(":1.9", "/org/a11y/atspi/accessible/root", pid),
        ProcessFacts {
            executable: None,
            comm: "gnome-calculator".to_owned(),
            exe_basename: Some("gnome-calculator".to_owned()),
            instance: "boot:1".to_owned(),
        },
        answered.then(|| Some("Calculator".to_owned())),
        ToolkitId::default(),
    )
}

fn client(id: u32, pid: u32, hidden: bool) -> X11Client {
    X11Client {
        shadow: (0, 0, 0, 0),
        id,
        pid: Some(pid),
        title: format!("window {id}"),
        extents: None,
        bounds: Some(Extents {
            x: 10,
            y: 20,
            width: 300,
            height: 200,
        }),
        hidden,
    }
}

fn ready(clients: Vec<X11Client>) -> X11State {
    X11State::Ready {
        active: None,
        clients,
    }
}

fn registry(apps: Vec<RegistryApp>) -> Registry {
    Registry {
        apps,
        skipped: Vec::new(),
    }
}

#[test]
fn the_stopped_window_the_display_server_names_active_stays_a_focus_claim() {
    let registry = registry(vec![app(7, false), app(8, false)]);
    let state = X11State::Ready {
        active: Some(0x40_0003),
        clients: vec![client(0x40_0003, 7, false), client(0x40_0009, 8, false)],
    };
    let windows = of_stopped_apps(&registry, |_| true, |_, _| true, &state, |_, _| None);
    let active: Vec<(u32, bool)> = windows
        .iter()
        .map(|window| (window.info.pid.get(), window.active))
        .collect();
    assert_eq!(active, [(7, true), (8, false)]);
}

#[test]
fn a_stopped_apps_clients_are_listed_as_not_accessible_with_decodable_distinct_ids() {
    let registry = registry(vec![app(7, false)]);
    let state = ready(vec![
        client(0x40_0003, 7, false),
        client(0x40_0009, 7, true),
    ]);
    let windows = of_stopped_apps(
        &registry,
        |_| true,
        |pid, instance| pid == 7 && instance == "boot:1",
        &state,
        |_, _| None,
    );
    assert_eq!(windows.len(), 2);
    assert_ne!(windows[0].info.id, windows[1].info.id);
    for window in &windows {
        let (bus, _) = window_id::decode(&window.info.id).expect("an id of this adapter");
        assert_eq!(bus, ":1.9");
        assert!(!window.info.state.accessible);
        assert_eq!(window.info.pid.get(), 7);
        assert_eq!(window.info.process_instance.as_deref(), Some("boot:1"));
        assert_eq!(window.info.bounds.expect("bounds").width, 300.0);
    }
    assert_eq!(windows[1].info.state.minimized, Some(true));
}

#[test]
fn only_stopped_unanswering_selected_apps_and_their_own_clients_are_listed() {
    let state = ready(vec![client(1, 7, false), client(2, 8, false)]);
    let running = registry(vec![app(7, false)]);
    assert!(of_stopped_apps(&running, |_| true, |_, _| false, &state, |_, _| None).is_empty());
    let answering = registry(vec![app(7, true)]);
    assert!(of_stopped_apps(&answering, |_| true, |_, _| true, &state, |_, _| None).is_empty());
    let stopped = registry(vec![app(7, false)]);
    assert!(of_stopped_apps(&stopped, |_| false, |_, _| true, &state, |_, _| None).is_empty());
    let own = of_stopped_apps(&stopped, |_| true, |_, _| true, &state, |_, _| None);
    assert_eq!(own.len(), 1);
    assert_eq!(own[0].info.pid.get(), 7);
}

#[test]
fn a_recycled_pid_does_not_claim_the_replacement_process_clients() {
    let registry = registry(vec![app(7, false)]);
    let state = ready(vec![client(1, 7, false)]);
    let replacement_instance = "boot:2";
    let windows = of_stopped_apps(
        &registry,
        |_| true,
        |pid, instance| pid == 7 && instance == replacement_instance,
        &state,
        |_, _| None,
    );
    assert!(windows.is_empty());
}

#[test]
fn two_registry_entries_of_one_stopped_process_list_each_window_once() {
    let registry = registry(vec![app(7, false), app(7, false)]);
    let state = ready(vec![client(1, 7, false)]);
    assert_eq!(
        of_stopped_apps(&registry, |_| true, |_, _| true, &state, |_, _| None).len(),
        1
    );
}

#[test]
fn no_display_evidence_lists_nothing() {
    let registry = registry(vec![app(7, false)]);
    assert!(
        of_stopped_apps(
            &registry,
            |_| true,
            |_, _| true,
            &X11State::Unavailable,
            |_, _| None
        )
        .is_empty()
    );
    assert!(
        of_stopped_apps(
            &registry,
            |_| true,
            |_, _| true,
            &X11State::NoWindowManager,
            |_, _| None
        )
        .is_empty()
    );
}

#[test]
fn a_window_listed_before_the_stop_keeps_the_id_it_had() {
    let registry = registry(vec![app(7, false)]);
    let state = ready(vec![
        client(0x40_0003, 7, false),
        client(0x40_0009, 7, false),
    ]);
    let windows = of_stopped_apps(
        &registry,
        |_| true,
        |_, _| true,
        &state,
        |xid, instance| {
            (xid == 0x40_0003 && instance == "boot:1").then(|| "w-1.9-org-gnome-before".to_owned())
        },
    );
    assert_eq!(windows[0].info.id, "w-1.9-org-gnome-before");
    assert!(windows[1].info.id.contains("stopped"));
}
