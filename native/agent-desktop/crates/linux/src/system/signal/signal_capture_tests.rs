use std::{thread::sleep, time::Duration};

use agent_desktop_core::{
    AdapterError, Deadline, ErrorCode, ProcessIdentity, SignalBaseline, SignalFilter,
    SnapshotSurface, WindowInfo, WindowState, diff_signals,
};

use super::signal_capture_fixture::{Reads, Scripted, app, window};
use super::{CaptureWorld, capture};
use crate::system::focus::decide_focus;
use crate::system::registry::Registry;
use crate::system::registry::app_outcome::AppOutcome;
use crate::system::registry::registry_app::RegistryApp;
use crate::system::registry::registry_frames::RootRead;
use crate::system::signal::signal_inventory::Pass;
use crate::system::x11::{FrameFacts, X11Evidence};
use crate::system::{menu::surface_scan::NestedScan, registry::listed_window::ListedWindow};

#[path = "signal_windowless_tests.rs"]
mod windowless;

struct World {
    apps: Vec<RegistryApp>,
    windows: Vec<Scripted>,
    timed_out: Vec<usize>,
    stopped: Vec<u32>,
    evidence: X11Evidence,
    outlast_deadline: bool,
    reads: Reads,
}

impl World {
    fn new(apps: Vec<RegistryApp>, windows: Vec<Scripted>) -> Self {
        Self {
            apps,
            windows,
            timed_out: Vec::new(),
            stopped: Vec::new(),
            evidence: X11Evidence::Unavailable,
            outlast_deadline: false,
            reads: Reads::default(),
        }
    }
}

fn listed(app: &RegistryApp, scripted: &Scripted) -> ListedWindow {
    ListedWindow {
        app: scripted.owner,
        info: WindowInfo {
            id: scripted.id.to_owned(),
            title: scripted.id.to_owned(),
            app: app.name.clone(),
            pid: app.root.pid().into(),
            process_instance: Some(app.facts.instance.clone()),
            bounds: None,
            state: WindowState {
                is_focused: false,
                accessible: true,
                minimized: None,
                visible: Some(true),
            },
        },
        active: scripted.active,
        modal: false,
        dialog: false,
        frame: FrameFacts {
            size_identity: false,
            pid: app.root.pid(),
            title: scripted.id.to_owned(),
            extents: None,
            global_position: false,
        },
        sheet: scripted.sheet,
        unshown: false,
    }
}

impl CaptureWorld for World {
    fn nested(&self, _: &[ListedWindow], _: Deadline) -> NestedScan {
        NestedScan::complete_and_empty()
    }

    fn registry(&self, pid: Option<u32>, _deadline: Deadline) -> Result<Registry, AdapterError> {
        self.reads.registry_asks.borrow_mut().push(pid);
        Ok(Registry {
            apps: self.apps.clone(),
            skipped: Vec::new(),
        })
    }

    fn pass(
        &self,
        registry: &Registry,
        select: &dyn Fn(&RegistryApp) -> bool,
        deadline: Deadline,
    ) -> Result<Pass, AdapterError> {
        while self.outlast_deadline && !deadline.is_expired() {
            sleep(Duration::from_millis(1));
        }
        let chosen: Vec<usize> = registry
            .apps
            .iter()
            .enumerate()
            .filter(|(_, app)| select(app))
            .map(|(index, _)| index)
            .collect();
        self.reads.roots_read.borrow_mut().extend(&chosen);
        let windows: Vec<ListedWindow> = self
            .windows
            .iter()
            .filter(|scripted| chosen.contains(&scripted.owner))
            .map(|scripted| listed(&registry.apps[scripted.owner], scripted))
            .collect();
        let candidates: Vec<usize> = windows
            .iter()
            .enumerate()
            .filter(|(_, window)| window.active)
            .map(|(index, _)| index)
            .collect();
        let focused = decide_focus(&candidates, self.evidence);
        let outcomes = chosen
            .iter()
            .map(|&index| AppOutcome {
                app: index,
                read: if self.timed_out.contains(&index) {
                    RootRead::TimedOut
                } else {
                    RootRead::Read
                },
            })
            .collect();
        Ok(Pass {
            windows,
            outcomes,
            candidates,
            focused,
            menu_focus_complete: true,
            recovered: Vec::new(),
        })
    }

    fn is_stopped(&self, pid: u32) -> bool {
        self.stopped.contains(&pid)
    }
}

fn deadline() -> Deadline {
    Deadline::after(5_000).expect("deadline")
}

fn scoped_to(name: &str) -> SignalFilter {
    SignalFilter {
        app: Some(name.to_owned()),
        process: None,
    }
}

#[test]
fn uncertain_menu_focus_marks_only_the_window_signal_class_incomplete() {
    let world = World::new(vec![app(1, "alpha", true)], vec![window(0, "doc")]);
    let registry = world.registry(None, deadline()).unwrap();
    let mut pass = world.pass(&registry, &|_| true, deadline()).unwrap();
    pass.menu_focus_complete = false;
    let baseline = super::assemble(
        &registry,
        &pass,
        super::Scope::Scoped,
        &NestedScan::complete_and_empty(),
        false,
    );
    assert!(!baseline.completeness.windows);
    assert!(baseline.completeness.apps);
    assert!(baseline.completeness.surfaces);
}

fn take(world: &World, filter: &SignalFilter) -> SignalBaseline {
    capture(world, filter, deadline()).expect("capture")
}

fn kinds(before: &SignalBaseline, after: &SignalBaseline) -> Vec<&'static str> {
    diff_signals(before, after)
        .iter()
        .map(|event| event.kind.cli_token())
        .collect()
}

fn delta(before: &World, after: &World) -> Vec<&'static str> {
    kinds(
        &take(before, &SignalFilter::default()),
        &take(after, &SignalFilter::default()),
    )
}

#[test]
fn a_clean_scoped_capture_is_complete_on_all_three_classes() {
    let mut sheet = window(0, "w-2");
    sheet.sheet = true;
    let world = World::new(vec![app(1, "calc", true)], vec![window(0, "w-1"), sheet]);
    let baseline = take(&world, &scoped_to("calc"));
    assert!(baseline.completeness.windows);
    assert!(baseline.completeness.apps);
    assert!(baseline.completeness.surfaces);
    assert_eq!(baseline.windows.len(), 2);
    assert_eq!(baseline.apps.len(), 1);
    assert_eq!(baseline.surfaces.len(), 1);
    assert_eq!(baseline.surfaces[0].kind, SnapshotSurface::Sheet);
}

#[test]
fn a_scoped_target_that_is_stopped_is_unresponsive_with_its_identity() {
    let mut world = World::new(vec![app(1, "calc", false)], vec![]);
    world.stopped = vec![101];
    let error = capture(&world, &scoped_to("calc"), deadline()).expect_err("error");
    assert_eq!(error.code, ErrorCode::AppUnresponsive);
    let details = error.details.clone().expect("details");
    assert_eq!(details["app"], "calc");
    assert_eq!(details["pid"], 101);
    assert_eq!(details["process_instance"], "boot:1");
    assert_eq!(details["retryable"], false);
    assert!(!error.permits_retry_by_default());
    assert!(world.reads.roots_read.borrow().is_empty());
}

#[test]
fn a_scoped_target_that_is_alive_but_slow_is_incomplete_not_an_error() {
    let mut world = World::new(vec![app(1, "calc", false)], vec![]);
    world.timed_out = vec![0];
    let baseline = take(&world, &scoped_to("calc"));
    assert!(!baseline.completeness.windows);
    assert!(!baseline.completeness.apps);
    assert!(!baseline.completeness.surfaces);
}

#[test]
fn an_unscoped_capture_with_an_unread_app_marks_windows_apps_and_surfaces_incomplete() {
    let mut world = World::new(
        vec![app(1, "calc", true), app(2, "busy", true)],
        vec![window(0, "w-1")],
    );
    world.timed_out = vec![1];
    let baseline = take(&world, &SignalFilter::default());
    assert!(!baseline.completeness.windows);
    assert!(!baseline.completeness.apps);
    assert!(!baseline.completeness.surfaces);
    assert_eq!(baseline.windows.len(), 1);
}

#[test]
fn an_unscoped_capture_never_scans_surfaces() {
    let mut sheet = window(0, "w-2");
    sheet.sheet = true;
    let world = World::new(vec![app(1, "calc", true)], vec![sheet]);
    let baseline = take(&world, &SignalFilter::default());
    assert!(baseline.surfaces.is_empty());
    assert!(!baseline.completeness.surfaces);
    assert!(baseline.completeness.windows);
    assert!(baseline.completeness.apps);
}

#[test]
fn two_active_windows_without_a_manager_answer_make_windows_incomplete_only() {
    let mut first = window(0, "w-1");
    first.active = true;
    let mut second = window(0, "w-2");
    second.active = true;
    let world = World::new(vec![app(1, "calc", true)], vec![first, second]);
    let baseline = take(&world, &SignalFilter::default());
    assert!(!baseline.completeness.windows);
    assert!(baseline.completeness.apps);
    assert!(
        baseline
            .windows
            .iter()
            .all(|window| !window.state.is_focused)
    );
}

#[test]
fn one_decided_focus_marks_that_window_and_stays_complete() {
    let mut only = window(0, "w-1");
    only.active = true;
    let world = World::new(vec![app(1, "calc", true)], vec![only, window(0, "w-2")]);
    let baseline = take(&world, &SignalFilter::default());
    assert!(baseline.completeness.windows);
    let focused: Vec<&str> = baseline
        .windows
        .iter()
        .filter(|window| window.state.is_focused)
        .map(|window| window.id.as_str())
        .collect();
    assert_eq!(focused, ["w-1"]);
}

#[test]
fn two_captures_of_an_unchanged_desktop_diff_to_nothing() {
    let world = World::new(
        vec![app(1, "calc", true), app(2, "files", true)],
        vec![window(0, "w-1"), window(1, "w-2")],
    );
    let first = take(&world, &SignalFilter::default());
    let second = take(&world, &SignalFilter::default());
    assert!(diff_signals(&first, &second).is_empty());
}

#[test]
fn a_window_of_a_new_app_is_a_window_opened_and_an_app_launched() {
    let apps = vec![app(1, "calc", true), app(2, "files", true)];
    let before = World::new(apps.clone(), vec![window(0, "w-1")]);
    let after = World::new(apps, vec![window(0, "w-1"), window(1, "w-2")]);
    let events = delta(&before, &after);
    assert_eq!(events, ["window-opened", "app-launched"]);
}

#[test]
fn a_window_that_goes_away_is_a_window_closed_and_an_app_terminated() {
    let apps = vec![app(1, "calc", true), app(2, "files", true)];
    let before = World::new(apps.clone(), vec![window(0, "w-1"), window(1, "w-2")]);
    let after = World::new(apps, vec![window(0, "w-1")]);
    let events = delta(&before, &after);
    assert_eq!(events, ["window-closed", "app-terminated"]);
}

#[test]
fn a_handoff_window_under_a_running_process_is_a_window_opened_alone() {
    let apps = vec![app(1, "editor", true)];
    let before = World::new(apps.clone(), vec![window(0, "w-1")]);
    let after = World::new(apps, vec![window(0, "w-1"), window(0, "w-2")]);
    let before = take(&before, &SignalFilter::default());
    let after = take(&after, &SignalFilter::default());
    assert_eq!(before.apps.len(), 1);
    assert_eq!(after.apps.len(), 1);
    assert_eq!(before.apps[0].pid, after.apps[0].pid);
    assert_eq!(kinds(&before, &after), ["window-opened"]);
}

#[test]
fn a_scoped_capture_for_one_app_never_reads_another_apps_roots() {
    let world = World::new(
        vec![app(1, "calc", true), app(2, "files", true)],
        vec![window(0, "w-1"), window(1, "w-2")],
    );
    let baseline = take(&world, &scoped_to("files"));
    assert_eq!(*world.reads.roots_read.borrow(), [1]);
    assert_eq!(baseline.windows.len(), 1);
    assert_eq!(baseline.windows[0].id, "w-2");
}

#[test]
fn a_process_filter_reads_the_registry_for_that_pid_and_selects_only_it() {
    let world = World::new(
        vec![app(1, "calc", true), app(2, "files", true)],
        vec![window(0, "w-1"), window(1, "w-2")],
    );
    let filter = SignalFilter {
        app: None,
        process: Some(ProcessIdentity::new(102_u32, "boot:2")),
    };
    take(&world, &filter);
    assert_eq!(*world.reads.registry_asks.borrow(), [Some(102)]);
    assert_eq!(*world.reads.roots_read.borrow(), [1]);
}

#[test]
fn a_reused_pid_with_another_instance_is_still_published_for_core_to_refuse() {
    let world = World::new(vec![app(1, "calc", true)], vec![window(0, "w-1")]);
    let filter = SignalFilter {
        app: None,
        process: Some(ProcessIdentity::new(101_u32, "boot:other")),
    };
    let baseline = take(&world, &filter);
    assert_eq!(baseline.windows.len(), 1);
    assert_eq!(
        baseline.windows[0].process_instance.as_deref(),
        Some("boot:1")
    );
}

#[test]
fn a_spent_deadline_reads_nothing_and_returns_a_timeout() {
    let world = World::new(vec![app(1, "calc", true)], vec![window(0, "w-1")]);
    let spent = Deadline::after(1).expect("deadline");
    sleep(Duration::from_millis(5));
    let error = capture(&world, &SignalFilter::default(), spent).expect_err("error");
    assert_eq!(error.code, ErrorCode::Timeout);
    assert!(world.reads.registry_asks.borrow().is_empty());
}

#[test]
fn a_capture_that_finishes_after_the_deadline_is_not_published() {
    let mut world = World::new(vec![app(1, "calc", true)], vec![window(0, "w-1")]);
    world.outlast_deadline = true;
    let roomy = Deadline::after(2_000).expect("deadline");
    let error = capture(&world, &SignalFilter::default(), roomy).expect_err("error");
    assert_eq!(error.code, ErrorCode::Timeout);
    assert!(
        !world.reads.roots_read.borrow().is_empty(),
        "read before expiry"
    );
}
