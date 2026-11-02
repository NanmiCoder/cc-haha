use super::{Population, classified, without_owner_frames};
use crate::system::registry::listed_window::ListedWindow;
use crate::system::x11::{FrameFacts, X11Client};
use crate::tree::Extents;
use agent_desktop_core::{Deadline, WindowInfo, WindowState};
use std::collections::{HashMap, HashSet};

const APP: u32 = 5;
const WINDOWED_UNPROVEN: u32 = 7;
const DECORATION_HOST: u32 = 9;

fn bounds(x: i32) -> Extents {
    Extents {
        x,
        y: 0,
        width: 400,
        height: 300,
    }
}

fn window(pid: u32, x: i32) -> ListedWindow {
    ListedWindow {
        app: 0,
        info: WindowInfo {
            id: format!("window-{pid}"),
            title: format!("window {pid}"),
            app: "app".to_owned(),
            pid: pid.into(),
            process_instance: Some(format!("boot:{pid}")),
            bounds: None,
            state: WindowState::default(),
        },
        active: false,
        modal: false,
        dialog: false,
        frame: FrameFacts {
            size_identity: false,
            pid,
            title: format!("window {pid}"),
            extents: Some(bounds(x)),
            global_position: true,
        },
        sheet: false,
        unshown: false,
    }
}

fn client(id: u32, pid: u32, x: i32) -> X11Client {
    X11Client {
        id,
        pid: Some(pid),
        title: format!("window {pid}"),
        extents: None,
        bounds: Some(bounds(x)),
        hidden: false,
        shadow: (0, 0, 0, 0),
    }
}

fn population() -> Population {
    Population {
        clients: vec![client(20, APP, 0), client(30, WINDOWED_UNPROVEN, 1000)],
        users: HashMap::from([
            (APP, HashSet::from([20])),
            (WINDOWED_UNPROVEN, HashSet::from([30])),
        ]),
        helper_ids: HashSet::new(),
        complete: HashSet::from([APP]),
        absent: HashSet::new(),
        windowed: HashSet::from([APP, WINDOWED_UNPROVEN]),
    }
}

fn deadline() -> Deadline {
    Deadline::after(10_000).unwrap()
}

#[test]
fn an_unprovable_frame_of_a_proven_helper_is_dropped_and_the_real_window_stays() {
    let windows = [window(APP, 0), window(DECORATION_HOST, 500)];
    let listed = classified(
        &windows,
        &population(),
        |pid| pid == DECORATION_HOST,
        deadline(),
    )
    .expect("the helper frame is skipped, not refused");
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].frame.pid, APP);
}

#[test]
fn an_unprovable_frame_of_a_process_not_proven_a_helper_stays_listed() {
    let windows = [window(APP, 0), window(DECORATION_HOST, 500)];
    let listed = classified(&windows, &population(), |_| false, deadline())
        .expect("an unclassified window is neither hidden nor a refusal");
    let pids: Vec<_> = listed.iter().map(|window| window.frame.pid).collect();
    assert_eq!(pids, [APP, DECORATION_HOST]);
}

#[test]
fn a_process_the_window_manager_manages_a_window_of_is_never_dropped_as_a_helper() {
    let windows = [window(APP, 0), window(WINDOWED_UNPROVEN, 1000)];
    let listed = classified(&windows, &population(), |_| true, deadline())
        .expect("a process with a managed window is an application");
    let pids: Vec<_> = listed.iter().map(|window| window.frame.pid).collect();
    assert_eq!(pids, [APP, WINDOWED_UNPROVEN]);
}

#[test]
fn the_display_owners_frames_are_dropped_and_every_other_application_stays() {
    let windows = vec![window(APP, 0), window(DECORATION_HOST, 500)];
    let kept = without_owner_frames(windows.clone(), |pid| pid == DECORATION_HOST, deadline())
        .expect("the owner's frames are dropped");
    assert_eq!(kept.len(), 1);
    assert_eq!(kept[0].frame.pid, APP);
    let unproven = without_owner_frames(windows, |_| false, deadline())
        .expect("an owner that is not proven hides nothing");
    assert_eq!(unproven.len(), 2);
}

#[test]
fn a_process_with_several_unprovable_frames_is_proven_once() {
    let windows = [
        window(APP, 0),
        window(DECORATION_HOST, 500),
        window(DECORATION_HOST, 900),
    ];
    let proofs = std::cell::Cell::new(0);
    let listed = classified(
        &windows,
        &population(),
        |_| {
            proofs.set(proofs.get() + 1);
            true
        },
        deadline(),
    )
    .expect("the helper frames are skipped");
    assert_eq!(listed.len(), 1);
    assert_eq!(proofs.get(), 1);
}
