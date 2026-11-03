use std::time::{Duration, Instant};

use agent_desktop_core::{AppInfo, Deadline, DeliverySemantics, ErrorCode, WindowFilter};

use super::close_plan::TERM_GRACE;
use crate::system::close::close_app;
use crate::system::process::process_facts;
use crate::system::{SharedBus, app_inventory, apps_scoped, list_windows};
use crate::tree::live::test_support::{BLOCKING_ARGS, copy_blocking_program};
use rig::{Orphan, lease};

#[path = "close_live/rig.rs"]
pub(in crate::system) mod rig;

const SETTLE: Duration = Duration::from_secs(40);

pub(in crate::system) fn deadline() -> Deadline {
    Deadline::after(10_000).expect("a deadline builds")
}

fn scoped(app: &str) -> WindowFilter {
    WindowFilter {
        focused_only: false,
        app: Some(app.to_owned()),
    }
}

pub(in crate::system) fn listed(bus: &SharedBus, pid: u32) -> AppInfo {
    let started = Instant::now();
    while started.elapsed() < SETTLE {
        let inventory = app_inventory(bus, deadline()).map(|found| found.apps);
        let found = inventory
            .ok()
            .and_then(|apps| apps.into_iter().find(|app| app.pid == pid));
        if let Some(app) = found
            && list_windows(bus, &scoped(&app.name), deadline()).is_ok_and(|w| !w.is_empty())
        {
            let matches = apps_scoped(bus, &app.name, None, deadline()).unwrap_or_default();
            assert_eq!(
                matches.len(),
                1,
                "the registry holds exactly one match for {}, and it is the spawned process",
                app.name
            );
            assert_eq!(matches[0].pid, pid);
            return app;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    panic!("pid {pid} never listed a window");
}

fn graceful_close_ends_the_process(orphan: &Orphan, app: &AppInfo) {
    orphan.wait_for_window();
    let started = Instant::now();
    close_app(&SharedBus::default(), app, false, &lease(20_000)).expect("a graceful close is Ok");
    println!(
        "close_live {}: graceful close Ok in {}ms",
        app.name,
        started.elapsed().as_millis()
    );
    assert!(!orphan.alive(), "the process exited");
    orphan.wait_gone_from_proc();
    assert_eq!(orphan.window_count(), 0, "no window is left");
}

#[test]
#[ignore = "drives real desktop applications; run through scripts/private-session.sh --wm"]
fn close_live_calculator_graceful() {
    let bus = SharedBus::default();
    let orphan = Orphan::spawn("gnome-calculator", &[], &[]);
    let app = listed(&bus, orphan.pid);
    graceful_close_ends_the_process(&orphan, &app);
    let after = app_inventory(&bus, deadline()).expect("inventory");
    assert!(after.apps.iter().all(|listed| listed.pid != orphan.pid));
}

#[test]
#[ignore = "drives real desktop applications; run through scripts/private-session.sh --wm"]
fn close_live_text_editor_two_windows_graceful() {
    let bus = SharedBus::default();
    let orphan = Orphan::spawn("gnome-text-editor", &["--new-window"], &[]);
    let app = listed(&bus, orphan.pid);
    let second = std::process::Command::new("gnome-text-editor")
        .arg("--new-window")
        .stdin(std::process::Stdio::null())
        .status();
    assert!(second.is_ok_and(|status| status.success()));
    let started = Instant::now();
    while orphan.window_count() < 2 {
        assert!(started.elapsed() < SETTLE, "the second window never mapped");
        std::thread::sleep(Duration::from_millis(200));
    }
    graceful_close_ends_the_process(&orphan, &app);
}

#[test]
#[ignore = "drives real desktop applications; run through scripts/private-session.sh --wm"]
fn close_live_a_stopped_app_is_unresponsive_gracefully_and_killed_by_force() {
    let bus = SharedBus::default();
    let orphan = Orphan::spawn("gnome-calculator", &[], &[]);
    let app = listed(&bus, orphan.pid);
    orphan.stop();
    let error = close_app(&bus, &app, false, &lease(10_000)).expect_err("stopped");
    assert_eq!(error.code, ErrorCode::AppUnresponsive);
    assert!(orphan.alive(), "a graceful close signals nothing");
    let started = Instant::now();
    close_app(&bus, &app, true, &lease(10_000)).expect("a forced close kills a stopped app");
    assert!(!orphan.alive());
    let mut left_registry = None;
    while started.elapsed() < Duration::from_secs(5) {
        let inventory = app_inventory(&bus, deadline()).expect("inventory");
        if inventory.apps.iter().all(|listed| listed.pid != orphan.pid) {
            left_registry = Some(started.elapsed());
            break;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    let seen = left_registry.expect("the killed app left the registry");
    println!(
        "close_live: killed stopped app left the registry in {}ms",
        seen.as_millis()
    );
    let scoped_after = apps_scoped(&bus, "Calculator", None, deadline()).unwrap_or_default();
    assert!(scoped_after.iter().all(|listed| listed.pid != orphan.pid));
}

#[test]
#[ignore = "drives real desktop applications; run through scripts/private-session.sh"]
fn close_live_a_child_that_ignores_term_is_killed_after_the_grace() {
    let orphan = Orphan::spawn(
        "sh",
        &["-c", "trap '' TERM; while :; do sleep 1; done"],
        &[],
    );
    orphan.wait_for_ignored_signal(15);
    let app = orphan.app("trapper");
    let started = Instant::now();
    close_app(&SharedBus::default(), &app, true, &lease(15_000)).expect("killed");
    let took = started.elapsed();
    println!(
        "close_live: SIGTERM-proof child ended after {}ms",
        took.as_millis()
    );
    assert!(took >= TERM_GRACE, "SIGKILL waited out the grace");
    assert!(took < TERM_GRACE + Duration::from_secs(2));
    assert!(!orphan.alive());
}

#[test]
#[ignore = "drives real desktop applications; run through scripts/private-session.sh"]
fn close_live_a_plain_term_is_enough_and_kill_is_never_sent_first() {
    let orphan = Orphan::spawn("sleep", &["120"], &[]);
    let started = Instant::now();
    close_app(
        &SharedBus::default(),
        &orphan.app("sleeper"),
        true,
        &lease(15_000),
    )
    .expect("ended");
    assert!(started.elapsed() < TERM_GRACE, "SIGTERM alone ended it");
    assert!(!orphan.alive());
}

#[test]
#[ignore = "drives real desktop applications; run through scripts/private-session.sh"]
fn close_live_a_changed_token_leaves_the_live_process_alone() {
    let orphan = Orphan::spawn("sleep", &["120"], &[]);
    let mut app = orphan.app("sleeper");
    app.process_instance = Some("0000:1".to_owned());
    for force in [false, true] {
        close_app(&SharedBus::default(), &app, force, &lease(5_000)).expect("benign");
        assert!(orphan.alive(), "force={force}");
    }
}

#[test]
#[ignore = "drives real desktop applications; run through scripts/private-session.sh"]
fn close_live_service_names_do_not_protect_unrelated_processes() {
    let dir = std::path::PathBuf::from(std::env::var("AGENT_DESKTOP_PRIVATE_SESSION").unwrap())
        .join("decoys");
    std::fs::create_dir_all(&dir).unwrap();
    for name in ["gnome-shell", "mutter-x11-frames", "xdg-desktop-portal"] {
        let decoy = copy_blocking_program(&dir, name);
        let orphan = Orphan::spawn(decoy.to_str().unwrap(), &BLOCKING_ARGS, &[]);
        close_app(
            &SharedBus::default(),
            &orphan.app(name),
            true,
            &lease(5_000),
        )
        .expect("a name does not establish session ownership");
        assert!(!orphan.alive());
    }
    std::fs::remove_dir_all(dir).unwrap();
}

fn unsaved_text_editor(bus: &SharedBus) -> (Orphan, AppInfo, std::path::PathBuf) {
    let dir = std::env::temp_dir().join(format!("ad-unsaved-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("document dir");
    let file = dir.join("notes.txt");
    std::fs::write(&file, "original\n").expect("document written");
    let path = file.to_string_lossy().into_owned();
    let mut orphan = Orphan::spawn("gnome-text-editor", &[&path], &[]);
    orphan.keep(dir);
    let app = listed(bus, orphan.pid);
    orphan.wait_for_window();
    orphan.type_text("edited");
    std::thread::sleep(Duration::from_secs(1));
    (orphan, app, file)
}

#[test]
#[ignore = "drives real desktop applications; run through scripts/private-session.sh --wm"]
fn close_live_text_editor_unsaved_document_times_out_without_a_signal() {
    let bus = SharedBus::default();
    let (orphan, app, file) = unsaved_text_editor(&bus);
    let started = Instant::now();
    let error = close_app(&bus, &app, false, &lease(4_000)).expect_err("the prompt keeps it open");
    println!("close_live: unsaved close gave {error:?}");
    assert_eq!(error.code, ErrorCode::ActionFailed);
    assert_eq!(error.disposition, DeliverySemantics::delivered_unverified());
    assert!(
        started.elapsed() < Duration::from_millis(2_500),
        "the prompt is reported when it appears, not after the budget: {:?}",
        started.elapsed()
    );
    assert!(orphan.alive(), "no signal was sent");
    let details = error.details.expect("details");
    assert_eq!(details["cause"], "dialog_pending");
    assert!(
        details["dialogs"].as_u64().is_some_and(|n| n >= 1),
        "{details}"
    );
    assert!(
        details["dialog"]
            .as_str()
            .is_some_and(|title| !title.is_empty()),
        "the prompt is named: {details}"
    );
    assert_eq!(std::fs::read_to_string(&file).expect("read"), "original\n");

    let dialogs_before = rig::text_editor_dialogs(app.pid.get());
    assert!(dialogs_before >= 1, "the prompt is open");
    let again = close_app(&bus, &app, false, &lease(4_000)).expect_err("the prompt is still open");
    assert_eq!(again.code, ErrorCode::ActionFailed);
    assert_eq!(again.disposition, DeliverySemantics::not_delivered());
    assert_eq!(
        again.details.as_ref().expect("details")["cause"],
        "dialog_pending"
    );
    assert_eq!(
        rig::text_editor_dialogs(app.pid.get()),
        dialogs_before,
        "a second close leaves the user's prompt open"
    );
    assert!(orphan.alive());

    close_app(&bus, &app, true, &lease(10_000)).expect("force ends it");
    assert!(!orphan.alive());
    assert_eq!(std::fs::read_to_string(&file).expect("read"), "original\n");
}

#[test]
#[ignore = "reads only an owned display and bus; use a private managed session"]
fn close_live_the_private_sessions_own_processes_are_refused() {
    let output = std::process::Command::new("python3")
        .args(["-c", include_str!("close_live/owners.py")])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let pids: Vec<u32> = serde_json::from_slice(&output.stdout).unwrap();
    for pid in pids {
        let facts = process_facts::read(pid).unwrap();
        let app = AppInfo {
            name: "ordinary application".into(),
            pid: pid.into(),
            bundle_id: None,
            process_instance: Some(facts.instance),
            presentation: None,
        };
        for force in [false, true] {
            let error = close_app(&SharedBus::default(), &app, force, &lease(5_000)).unwrap_err();
            assert_eq!(error.code, ErrorCode::InvalidArgs);
            assert_eq!(error.disposition, DeliverySemantics::not_delivered());
        }
        assert!(
            crate::system::process::liveness::liveness(
                pid,
                app.process_instance.as_deref().unwrap()
            ) != crate::system::process::liveness::Liveness::Gone
        );
        println!(
            "independent xprop/socket/D-Bus owner pid {pid} remains alive after graceful and forced refusal"
        );
    }
    let after = std::process::Command::new("python3")
        .args(["-c", include_str!("close_live/owners.py")])
        .output()
        .unwrap();
    assert!(
        after.status.success(),
        "{}",
        String::from_utf8_lossy(&after.stderr)
    );
    assert_eq!(
        after.stdout, output.stdout,
        "independent native session owners did not change"
    );
}

const OWNED_FIXTURE: &str = "org.freedesktop.impl.portal.desktop.OwnedFixture";

fn service_owner(service: &str) -> Option<String> {
    let owner = std::process::Command::new("busctl")
        .args([
            "--user",
            "call",
            "org.freedesktop.DBus",
            "/org/freedesktop/DBus",
            "org.freedesktop.DBus",
            "GetConnectionUnixProcessID",
            "s",
            service,
        ])
        .output()
        .unwrap();
    owner
        .status
        .success()
        .then(|| String::from_utf8_lossy(&owner.stdout).trim().to_owned())
}

/// A process that owns `service` on the session bus and answers nothing on
/// the accessibility bus, started with `env`.
pub(in crate::system) fn portal_backend(service: &str, env: &[(&str, String)]) -> Orphan {
    let runtime = std::path::PathBuf::from(std::env::var("AGENT_DESKTOP_PRIVATE_SESSION").unwrap());
    let script = runtime.join(format!("{service}.py"));
    std::fs::write(
        &script,
        format!(
            r#"
import gi
from gi.repository import Gio,GLib
bus=Gio.bus_get_sync(Gio.BusType.SESSION,None)
Gio.bus_own_name_on_connection(bus,'{service}',Gio.BusNameOwnerFlags.NONE,None,None)
GLib.MainLoop().run()
"#
        ),
    )
    .unwrap();
    let orphan = Orphan::spawn("python3", &[script.to_str().unwrap()], env);
    let until = Instant::now() + Duration::from_secs(10);
    loop {
        if let Some(owner) = service_owner(service) {
            assert_eq!(owner, format!("u {}", orphan.pid));
            return orphan;
        }
        assert!(
            Instant::now() < until,
            "owned portal never acquired the service"
        );
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[test]
#[ignore = "starts an owned portal backend on a private session bus"]
fn close_live_service_ownership_protects_an_arbitrarily_named_process() {
    let orphan = portal_backend(OWNED_FIXTURE, &[]);
    for force in [false, true] {
        let error = close_app(
            &SharedBus::default(),
            &orphan.app("ordinary application"),
            force,
            &lease(5_000),
        )
        .unwrap_err();
        assert_eq!(error.code, ErrorCode::InvalidArgs);
        assert_eq!(error.disposition, DeliverySemantics::not_delivered());
        assert_eq!(
            service_owner(OWNED_FIXTURE),
            Some(format!("u {}", orphan.pid))
        );
        assert!(orphan.alive());
    }
    println!(
        "independent D-Bus credentials: portal backend pid {} remains alive after graceful and forced refusal",
        orphan.pid
    );
}
