use std::time::{Duration, Instant};

use agent_desktop_core::ProcessIdentity;
use agent_desktop_core::system::process_state::ProcessState;

use super::process_state::process_state;
use crate::system::close::close_live_tests::rig::Orphan;
use crate::system::close::close_live_tests::{deadline, listed};
use crate::system::{SharedBus, app_inventory};

const HEALTHY_BOUND: Duration = Duration::from_millis(50);
const STOPPED_BOUND: Duration = Duration::from_millis(1_000);
const SETTLE: Duration = Duration::from_secs(20);

fn identity(app: &agent_desktop_core::AppInfo) -> ProcessIdentity {
    ProcessIdentity::new(app.pid, app.process_instance.clone().expect("a token"))
}

fn listed_name(bus: &SharedBus, pid: u32) -> Option<String> {
    app_inventory(bus, deadline())
        .ok()?
        .apps
        .into_iter()
        .find(|app| app.pid == pid)
        .map(|app| app.name)
}

fn state_of(bus: &SharedBus, identity: &ProcessIdentity) -> (ProcessState, Duration) {
    let started = Instant::now();
    let state = process_state(bus, identity.clone(), deadline()).expect("never an error");
    (state, started.elapsed())
}

fn wait_for(bus: &SharedBus, identity: &ProcessIdentity, wanted: ProcessState) {
    let started = Instant::now();
    while started.elapsed() < SETTLE {
        if state_of(bus, identity).0 == wanted {
            return;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    panic!("never reached {wanted:?}");
}

#[test]
#[ignore = "drives real desktop applications; run through scripts/private-session.sh --wm"]
fn process_state_live_calculator_running_unresponsive_running_exited() {
    let bus = SharedBus::default();
    let orphan = Orphan::spawn("gnome-calculator", &[], &[]);
    let app = listed(&bus, orphan.pid);
    let identity = identity(&app);

    let healthy: Vec<Duration> = (0..5)
        .map(|_| {
            let (state, took) = state_of(&bus, &identity);
            assert_eq!(state, ProcessState::Running);
            took
        })
        .collect();
    let best = healthy.iter().min().copied().expect("five runs");
    println!("process_state_live: healthy Running in {healthy:?}");
    assert!(best < HEALTHY_BOUND, "best healthy answer {best:?}");

    let name = listed_name(&bus, orphan.pid).expect("listed");
    orphan.stop();
    let (state, took) = state_of(&bus, &identity);
    println!("process_state_live: stopped answered {state:?} in {took:?}");
    assert_eq!(state, ProcessState::Unresponsive);
    assert!(took < STOPPED_BOUND, "stopped answer took {took:?}");
    assert_eq!(
        listed_name(&bus, orphan.pid).as_deref(),
        Some(name.as_str())
    );
    let again = app_inventory(&bus, deadline()).expect("inventory");
    let token = again
        .apps
        .iter()
        .find(|listed| listed.pid == orphan.pid)
        .and_then(|listed| listed.process_instance.clone());
    assert_eq!(token, app.process_instance, "the token survives the stop");

    orphan.resume();
    wait_for(&bus, &identity, ProcessState::Running);

    drop(orphan);
    wait_for(&bus, &identity, ProcessState::Exited { code: None });
}

const BLOCKED_SCRIPT: &str = r#"
import time, sys
from pathlib import Path
import gi
gi.require_version("Gtk", "3.0")
from gi.repository import Gtk, GLib
w = Gtk.Window(title="adblock")
w.add(Gtk.Button(label="Press"))
w.connect("destroy", Gtk.main_quit)
w.show_all()
def block_when_requested():
    if not Path(sys.argv[1]).exists():
        return True
    Path(sys.argv[2]).write_text("entered")
    time.sleep(120)
    return False
GLib.timeout_add(20, block_when_requested)
Gtk.main()
"#;

#[test]
#[ignore = "drives real desktop applications; run through scripts/private-session.sh --wm"]
fn process_state_live_a_blocked_main_loop_is_unresponsive_while_it_sleeps_in_proc() {
    let bus = SharedBus::default();
    let dir = std::env::temp_dir().join(format!("ad-blocked-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("dir");
    let script = dir.join("app.py");
    std::fs::write(&script, BLOCKED_SCRIPT).expect("script");
    let arg = script.to_string_lossy().into_owned();
    let trigger = dir.join("block");
    let entered = dir.join("entered");
    let mut orphan = Orphan::spawn(
        "python3",
        &[&arg, &trigger.to_string_lossy(), &entered.to_string_lossy()],
        &[],
    );
    orphan.keep(dir);
    let app = listed(&bus, orphan.pid);
    let identity = identity(&app);
    std::fs::write(trigger, "block").expect("request main-loop block");
    let started = Instant::now();
    while !entered.exists() && started.elapsed() < SETTLE {
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(
        entered.exists(),
        "the main loop entered its blocking callback"
    );
    let started = Instant::now();
    let mut seen = None;
    while started.elapsed() < Duration::from_secs(20) {
        let (state, took) = state_of(&bus, &identity);
        if state == ProcessState::Unresponsive {
            seen = Some(took);
            break;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    let took = seen.expect("the blocked app became unresponsive");
    println!("process_state_live: blocked loop answered Unresponsive in {took:?}");
    let stat = std::fs::read_to_string(format!("/proc/{}/stat", orphan.pid)).expect("stat");
    let state = stat
        .rsplit(')')
        .next()
        .and_then(|rest| rest.split_whitespace().next());
    assert_eq!(state, Some("S"), "a blocked loop is not a stopped process");
}
