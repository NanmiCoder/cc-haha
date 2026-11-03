use std::process::Command;
use std::time::{Duration, Instant};

use agent_desktop_core::{
    Deadline, DeliverySemantics, ErrorCode, ProcessIdentity, WindowFilter, WindowOp,
};

use super::window_op::window_op;
use crate::system::interaction::interaction_lease::acquire;
use crate::system::{SharedBus, app_inventory, apps_scoped, list_surfaces, list_windows};
use crate::tree::live::live_launch::Launched;

const SETTLE: Duration = Duration::from_secs(40);

fn deadline() -> Deadline {
    Deadline::after(10_000).expect("a deadline builds")
}

fn scoped(app: &str) -> WindowFilter {
    WindowFilter {
        focused_only: false,
        app: Some(app.to_owned()),
    }
}

struct Stopped(u32);

impl Stopped {
    fn new(pid: u32) -> Self {
        let _ = Command::new("kill")
            .args(["-STOP", &pid.to_string()])
            .status();
        Self(pid)
    }
}

impl Drop for Stopped {
    fn drop(&mut self) {
        let _ = Command::new("kill")
            .args(["-CONT", &self.0.to_string()])
            .status();
    }
}

fn listed_name(bus: &SharedBus, pid: u32) -> Option<String> {
    app_inventory(bus, deadline())
        .ok()?
        .apps
        .into_iter()
        .find(|app| app.pid == pid)
        .map(|app| app.name)
}

fn answering_identity(bus: &SharedBus, pid: u32) -> (String, ProcessIdentity) {
    let started = Instant::now();
    while started.elapsed() < SETTLE {
        let apps = app_inventory(bus, deadline()).map(|inventory| inventory.apps);
        let found = apps
            .ok()
            .and_then(|apps| apps.into_iter().find(|app| app.pid == pid));
        let name = found.as_ref().map(|app| app.name.clone());
        if let (Some(name), Some(app)) = (name, found)
            && list_windows(bus, &scoped(&app.name), deadline()).is_ok_and(|w| !w.is_empty())
        {
            let instance = app.process_instance.expect("an instance");
            return (name, ProcessIdentity::new(pid, instance));
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    panic!("pid {pid} never listed a window");
}

fn check_stopped_app(program: &str, args: &[&str], registry_name: Option<&str>) {
    let bus = SharedBus::default();
    let mut launched = Launched::new();
    let pid = launched.spawn(program, args);
    let (name, identity) = answering_identity(&bus, pid);
    if let Some(registry_name) = registry_name {
        let found = apps_scoped(&bus, registry_name, None, deadline()).expect("scoped");
        assert!(
            found.iter().any(|app| app.pid == pid),
            "the registry name finds {program} while it answers"
        );
    }

    let stop = Stopped::new(pid);
    let after = listed_name(&bus, pid).expect("a stopped app stays listed");
    assert_eq!(after, name, "{program} keeps one name when it stops");

    let started = Instant::now();
    let windows = list_windows(&bus, &scoped(&name), deadline()).expect_err("scoped listing");
    assert_eq!(windows.code, ErrorCode::AppUnresponsive);
    let surfaces = list_surfaces(&bus, &identity, deadline()).expect_err("surface listing");
    assert_eq!(surfaces.code, ErrorCode::AppUnresponsive);
    println!(
        "stopped_live {program}: name={name} scoped listing and surfaces answered APP_UNRESPONSIVE in {}ms",
        started.elapsed().as_millis()
    );

    let everything = WindowFilter {
        focused_only: false,
        app: None,
    };
    let all = list_windows(&bus, &everything, deadline()).expect("an unscoped listing");
    let held = all
        .iter()
        .find(|window| window.pid == pid)
        .expect("the stopped app's window is listed from the display server");
    assert!(!held.state.accessible, "and marked as not readable");
    let lease = acquire(deadline()).expect("a lease");
    for op in [WindowOp::Minimize, WindowOp::Move { x: 5.0, y: 5.0 }] {
        let error = window_op(&bus, held, op, &lease).expect_err("a stopped app");
        assert_eq!(error.code, ErrorCode::AppUnresponsive);
        assert_eq!(error.disposition, DeliverySemantics::not_delivered());
    }
    drop(lease);

    drop(stop);
    let started = Instant::now();
    while started.elapsed() < SETTLE {
        if list_windows(&bus, &scoped(&name), deadline()).is_ok_and(|w| !w.is_empty()) {
            return;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    panic!("{program} did not list its window again after SIGCONT");
}

#[test]
#[ignore = "drives real desktop applications; run through scripts/private-session.sh"]
fn stopped_live_calculator_keeps_its_name_and_reports_unresponsive() {
    check_stopped_app("gnome-calculator", &[], None);
}

#[test]
#[ignore = "drives real desktop applications; run through scripts/private-session.sh"]
fn stopped_live_files_keeps_its_name_and_reports_unresponsive() {
    check_stopped_app("nautilus", &["--new-window"], Some("org.gnome.Nautilus"));
}
