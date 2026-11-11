use crate::system::registry::registry_frames::RootRead;
use std::cell::RefCell;

use agent_desktop_core::AdapterError;

use super::{chosen_apps, gather, pass_over, pass_over_with_menu};
use crate::system::process::process_facts::ProcessFacts;
use crate::system::process::toolkit_id::ToolkitId;
use crate::system::registry::Registry;
use crate::system::registry::frame_read::FrameRead;
use crate::system::registry::listed_window::ListedWindow;
use crate::system::registry::registry_app::{RegistryApp, assemble};
use crate::system::x11::X11State;
use crate::tree::live::test_support::{read_of, words};
use crate::tree::{AtspiElement, Field, RawNode};

fn app(bus: &str, pid: u32, exe: &str, answered: bool) -> RegistryApp {
    assemble(
        AtspiElement::new(bus, "/org/a11y/atspi/accessible/root", pid),
        ProcessFacts {
            executable: None,
            comm: exe.to_owned(),
            exe_basename: Some(exe.to_owned()),
            instance: "boot:1".to_owned(),
        },
        answered.then(|| Some(exe.to_owned())),
        ToolkitId::default(),
    )
}

fn registry(apps: Vec<RegistryApp>) -> Registry {
    Registry {
        apps,
        skipped: Vec::new(),
    }
}

fn frame(bus: &str, path: &str, pid: u32, state_bits: &[u32]) -> RawNode {
    let mut node = read_of(23, "Doc", &[]).node;
    node.element = AtspiElement::new(bus, path, pid);
    node.traits.interfaces = Field::Present(vec![crate::tree::COMPONENT_INTERFACE.to_owned()]);
    node.traits.states = Field::Present(words(state_bits));
    node
}

fn read(nodes: Vec<RawNode>, read: RootRead) -> FrameRead {
    FrameRead { nodes, read }
}

fn gathered(
    registry: &Registry,
    select: impl Fn(&RegistryApp) -> bool,
    frames: Vec<FrameRead>,
) -> (Vec<ListedWindow>, Vec<super::AppOutcome>, Vec<String>) {
    let chosen = chosen_apps(registry, select, |_| false);
    let asked = RefCell::new(Vec::new());
    let (windows, outcomes) = gather(&chosen, |roots| {
        asked
            .borrow_mut()
            .extend(roots.iter().map(|root| root.bus_name().to_owned()));
        Ok(frames)
    })
    .expect("gathers");
    (windows, outcomes, asked.into_inner())
}

#[test]
fn the_reader_is_never_asked_for_an_excluded_root() {
    let registry = registry(vec![
        app(":1.1", 1, "alpha", true),
        app(":1.2", 2, "beta", true),
    ]);
    let (_, _, asked) = gathered(
        &registry,
        |app| app.root.pid() == 2,
        vec![read(Vec::new(), RootRead::Read)],
    );
    assert_eq!(asked, [":1.2"]);
}

#[test]
fn an_unanswering_stopped_app_is_not_read_and_a_slow_alive_one_is() {
    let registry = registry(vec![
        app(":1.1", 1, "alpha", false),
        app(":1.2", 2, "beta", false),
        app(":1.3", 3, "gamma", true),
    ]);
    let chosen = chosen_apps(&registry, |_| true, |pid| pid == 1 || pid == 3);
    let pids: Vec<u32> = chosen.iter().map(|(_, app)| app.root.pid()).collect();
    assert_eq!(pids, [2, 3]);
}

#[test]
fn each_app_keeps_its_own_outcome_and_a_slow_app_never_hides_another() {
    let registry = registry(vec![
        app(":1.1", 1, "alpha", true),
        app(":1.2", 2, "beta", true),
    ]);
    let frames = vec![
        read(vec![frame(":1.1", "/f/1", 1, &[25])], RootRead::TimedOut),
        read(Vec::new(), RootRead::Read),
    ];
    let (windows, outcomes, _) = gathered(&registry, |_| true, frames);
    assert_eq!(windows.len(), 1);
    let reads: Vec<(usize, RootRead)> = outcomes.iter().map(|o| (o.app, o.read)).collect();
    assert_eq!(reads, [(0, RootRead::TimedOut), (1, RootRead::Read)]);
}

#[test]
fn outcome_indices_follow_the_registry_not_the_chosen_list() {
    let registry = registry(vec![
        app(":1.1", 1, "alpha", true),
        app(":1.2", 2, "beta", true),
    ]);
    let (_, outcomes, _) = gathered(
        &registry,
        |app| app.root.pid() == 2,
        vec![read(Vec::new(), RootRead::TimedOut)],
    );
    assert_eq!(outcomes.len(), 1);
    assert_eq!(outcomes[0].app, 1);
}

fn menu_desktop() -> (Vec<ListedWindow>, Vec<super::AppOutcome>, X11State) {
    use crate::system::x11::X11Client;
    use crate::tree::Extents;
    let registry = registry(vec![app(":1.1", 1, "alpha", true)]);
    let mut menu = frame(":1.1", "/org/a11y/atspi/accessible/2", 1, &[25]);
    menu.properties.name = Field::Present(String::new());
    let frames = vec![read(
        vec![
            frame(":1.1", "/org/a11y/atspi/accessible/1", 1, &[25]),
            menu,
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
    (windows, outcomes, state)
}

#[test]
fn a_selected_app_with_no_outcome_is_skipped_and_one_with_an_outcome_is_not() {
    use super::{AppOutcome, Pass, skipped_selected};
    let registry = registry(vec![
        app(":1.1", 11, "calc", true),
        app(":1.2", 12, "edit", false),
    ]);
    let pass = |apps: &[usize]| Pass {
        windows: Vec::new(),
        outcomes: apps
            .iter()
            .map(|&app| AppOutcome {
                app,
                read: RootRead::Read,
            })
            .collect(),
        candidates: Vec::new(),
        focused: None,
        menu_focus_complete: true,
        recovered: Vec::new(),
    };
    assert!(skipped_selected(&registry, &pass(&[0]), |_| true));
    assert!(!skipped_selected(&registry, &pass(&[0, 1]), |_| true));
    assert!(!skipped_selected(&registry, &pass(&[0]), |app| app
        .root
        .pid()
        == 11));
}

#[test]
fn a_stopped_app_the_display_server_supplied_windows_for_is_not_skipped() {
    use super::{AppOutcome, Pass, skipped_selected};
    let registry = registry(vec![
        app(":1.1", 11, "calc", true),
        app(":1.2", 12, "edit", false),
    ]);
    let pass = Pass {
        windows: Vec::new(),
        outcomes: vec![AppOutcome {
            app: 0,
            read: RootRead::Read,
        }],
        candidates: Vec::new(),
        focused: None,
        menu_focus_complete: true,
        recovered: vec![1],
    };
    assert!(!skipped_selected(&registry, &pass, |_| true));
}

#[path = "signal_inventory_focus_tests.rs"]
mod focus_tests;

#[path = "signal_inventory_menu_tests.rs"]
mod menu_tests;
