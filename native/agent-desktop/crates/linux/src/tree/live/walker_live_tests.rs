use std::time::{Duration, Instant};

use agent_desktop_core::{Deadline, ErrorCode, NativeHandle};
use zbus::blocking::Connection;

use super::live_launch::{
    Launched, environment_note, nonce, program_of, run_leg, vscode_arguments,
};
use super::live_process::{is_running, process_report};
use super::live_qt;
use super::live_tree::{
    action_summary, count_failed, dump, failure_kinds, find_node, frames_where, pid_frame,
};
use crate::system::SharedBus;
use crate::tree::walk::walker::walk_tree;
use crate::tree::{AtspiElement, ObservedRead, Walk, WalkLimits, atspi_element};

pub(in crate::tree) const SETTLE_LIMIT: Duration = Duration::from_secs(40);
const POLL: Duration = Duration::from_millis(100);
const STABLE_POLLS: usize = 3;
const TIMED_RUNS: usize = 7;
const PUSH_BUTTON_ROLE: u32 = 43;
const TERMINAL_SERVER: &str = "gnome-terminal-server";

pub(in crate::tree) struct Settled {
    pub(in crate::tree) frame: AtspiElement,
    pub(in crate::tree) walk: Walk<ObservedRead>,
}

pub(in crate::tree) fn settle(
    bus: &SharedBus,
    min_nodes: usize,
    find_frame: impl FnMut() -> Option<AtspiElement>,
) -> Result<Settled, String> {
    settle_watching(bus, min_nodes, None, find_frame)
}

/// Waits for a stable, complete tree. Given the pid of the launched process
/// that owns the frame, it stops as soon as that process exits and reports its
/// exit status and stderr; its timeout message carries the end of that stderr.
pub(in crate::tree) fn settle_watching(
    bus: &SharedBus,
    min_nodes: usize,
    watched: Option<u32>,
    mut find_frame: impl FnMut() -> Option<AtspiElement>,
) -> Result<Settled, String> {
    let started = Instant::now();
    let mut last_count = 0;
    let mut stable = 0;
    let mut last_state = String::from("no frame appeared on the registry");
    while started.elapsed() < SETTLE_LIMIT {
        std::thread::sleep(POLL);
        if let Some(pid) = watched
            && !is_running(pid)
        {
            return Err(format!(
                "the app exited before its tree settled ({last_state}); {}",
                process_report(pid)
            ));
        }
        let Some(frame) = find_frame() else { continue };
        let deadline = Deadline::after(5_000).map_err(|error| error.message)?;
        match walk_tree(bus, &frame, &WalkLimits::default(), deadline) {
            Ok(walk) => {
                last_state = format!("{} nodes, complete={}", walk.node_count, walk.complete);
                if walk.complete && walk.node_count >= min_nodes && walk.node_count == last_count {
                    stable += 1;
                } else {
                    stable = 0;
                }
                last_count = walk.node_count;
                if stable >= STABLE_POLLS {
                    return Ok(Settled { frame, walk });
                }
            }
            Err(error) => last_state = format!("walk failed: {}", error.message),
        }
    }
    Err(format!(
        "tree did not settle within the limit: {last_state}; {}{}",
        environment_note(),
        watched.map_or_else(String::new, |pid| format!("; {}", process_report(pid)))
    ))
}

struct Timing {
    min: u128,
    median: u128,
    max: u128,
}

fn timed_walks(bus: &SharedBus, frame: &AtspiElement) -> Result<Timing, String> {
    let mut millis = Vec::new();
    for run in 0..=TIMED_RUNS {
        let deadline = Deadline::standard().map_err(|error| error.message)?;
        let started = Instant::now();
        let walk = walk_tree(bus, frame, &WalkLimits::default(), deadline)
            .map_err(|error| error.message)?;
        if !walk.complete {
            return Err(format!(
                "timed run {run} was incomplete after {} ms with {} nodes",
                started.elapsed().as_millis(),
                walk.node_count
            ));
        }
        if run > 0 {
            millis.push(started.elapsed().as_millis());
        }
    }
    millis.sort_unstable();
    Ok(Timing {
        min: millis[0],
        median: millis[millis.len() / 2],
        max: millis[millis.len() - 1],
    })
}

fn report(label: &str, settled: &Settled, timing: &Timing) -> usize {
    let failed = count_failed(&settled.walk.root);
    println!(
        "walker_live {label}: nodes={} depth={} complete={} read_errors={failed} ms min/median/max={}/{}/{}",
        settled.walk.node_count,
        settled.walk.max_depth,
        settled.walk.complete,
        timing.min,
        timing.median,
        timing.max
    );
    failed
}

fn walk_app(
    bus: &SharedBus,
    label: &str,
    min_nodes: usize,
    watched: Option<u32>,
    find_frame: impl FnMut() -> Option<AtspiElement>,
) -> Result<Settled, String> {
    let settled = settle_watching(bus, min_nodes, watched, find_frame)
        .map_err(|error| format!("{label}: {error}"))?;
    let timing = timed_walks(bus, &settled.frame).map_err(|error| format!("{label}: {error}"))?;
    let failed = report(label, &settled, &timing);
    let mut problems = Vec::new();
    if !settled.walk.complete {
        problems.push("walk incomplete".to_owned());
    }
    if failed > 0 {
        problems.push(format!("{failed} read errors"));
        for kind in failure_kinds(&settled.walk.root) {
            println!("walker_live {label} read error: {kind}");
        }
    }
    if problems.is_empty() {
        return Ok(settled);
    }
    let mut tree = String::new();
    dump(&settled.walk.root, 0, &mut tree);
    Err(format!("{label}: {}\n{tree}", problems.join(", ")))
}

fn check_handles(frame: &AtspiElement) -> Result<(), String> {
    let error = atspi_element(&NativeHandle::null()).expect_err("a null handle must be rejected");
    let details = error.details.as_ref();
    let kind = details.and_then(|details| details.get("kind"));
    if error.code != ErrorCode::InvalidArgs || kind != Some(&"invalid_native_handle".into()) {
        return Err(format!("null handle gave {:?} {details:?}", error.code));
    }
    let handle = frame.clone().into_native_handle();
    match atspi_element(&handle) {
        Ok(element) if element == frame => Ok(()),
        other => Err(format!("handle did not round-trip: {other:?}")),
    }
}

fn check_gone(bus: &SharedBus, frame: &AtspiElement) -> Result<(), String> {
    let started = Instant::now();
    while started.elapsed() < SETTLE_LIMIT {
        let deadline = Deadline::standard().map_err(|error| error.message)?;
        if let Err(error) = walk_tree(bus, frame, &WalkLimits::default(), deadline) {
            return if matches!(
                error.code,
                ErrorCode::AppNotFound | ErrorCode::ElementNotFound
            ) {
                println!("walker_live exited app classified as {:?}", error.code);
                Ok(())
            } else {
                Err(format!(
                    "exited app classified as {:?}: {}",
                    error.code, error.message
                ))
            };
        }
        std::thread::sleep(POLL);
    }
    Err("an exited app still answered".to_owned())
}

fn files(bus: &SharedBus, connection: &Connection) -> Result<(), String> {
    let mut launched = Launched::new();
    let pid = launched.try_spawn("nautilus", &["--new-window"])?;
    walk_app(bus, "files", 30, Some(pid), || pid_frame(connection, pid)).map(|_| ())
}

fn terminal(bus: &SharedBus, connection: &Connection) -> Result<(), String> {
    let is_server = |pid: u32| program_of(pid).as_deref() == Some(TERMINAL_SERVER);
    let known: Vec<AtspiElement> = frames_where(connection, is_server);
    let mut launched = Launched::new();
    let guard = std::env::temp_dir().join(nonce("terminal"));
    std::fs::create_dir_all(&guard).map_err(|error| error.to_string())?;
    launched.scratch.push(guard.clone());
    let script = format!(
        "while [ -d '{}' ] && kill -0 {} 2>/dev/null; do sleep 0.5; done",
        guard.display(),
        std::process::id()
    );
    let client = launched.try_spawn("gnome-terminal", &["--wait", "--", "bash", "-c", &script])?;
    walk_app(bus, "terminal", 20, Some(client), || {
        frames_where(connection, is_server)
            .into_iter()
            .find(|frame| {
                !known
                    .iter()
                    .any(|old| old.path() == frame.path() && old.bus_name() == frame.bus_name())
            })
    })
    .map(|_| ())
}

fn calculator(bus: &SharedBus, connection: &Connection) -> Result<(), String> {
    let mut launched = Launched::new();
    let pid = launched.try_spawn("gnome-calculator", &[])?;
    let settled = walk_app(bus, "calculator", 30, Some(pid), || {
        pid_frame(connection, pid)
    })?;
    let button = find_node(&settled.walk.root, &|node| {
        node.actions
            .present()
            .is_some_and(|actions| !actions.is_empty())
    })
    .ok_or_else(|| {
        format!(
            "no calculator node reported a non-empty action list: {}",
            action_summary(&settled.walk.root)
        )
    })?;
    println!(
        "walker_live calculator action sample: role={:?} name={:?} actions={:?}",
        button.traits.role_name.present(),
        button.properties.name.present(),
        button.actions.present()
    );
    check_handles(&settled.frame)?;
    launched.stop();
    check_gone(bus, &settled.frame)
}

fn qt(bus: &SharedBus, connection: &Connection) -> Result<(), String> {
    let mut launched = Launched::new();
    let pid = live_qt::launch(&mut launched)?;
    let settled = walk_app(bus, "qt", 15, Some(pid), || pid_frame(connection, pid))?;
    let button = find_node(&settled.walk.root, &|node| {
        node.traits.role.present() == Some(&PUSH_BUTTON_ROLE)
            && node
                .properties
                .name
                .present()
                .is_some_and(|name| name == live_qt::BUTTON_LABEL)
    });
    match button {
        Some(node) => {
            println!(
                "walker_live qt button name={:?}",
                node.properties.name.present()
            );
            Ok(())
        }
        None => Err("qt: no push button named with a non-empty name".to_owned()),
    }
}

fn vscode(bus: &SharedBus, connection: &Connection) -> Result<(), String> {
    let program = "code".to_owned();
    let mut launched = Launched::new();
    let data = std::env::temp_dir().join(nonce("vscode"));
    launched.scratch.push(data.clone());
    let data_arg = data.to_string_lossy().into_owned();
    let pid = launched.try_spawn(&program, &vscode_arguments(&data_arg))?;
    walk_app(bus, "vscode", 200, Some(pid), || pid_frame(connection, pid)).map(|_| ())
}

#[test]
#[ignore = "drives real desktop applications; run through scripts/linux-live-gate.sh"]
fn walker_live_real_apps() {
    let bus = SharedBus::default();
    let connection = bus
        .get(Deadline::standard().expect("a standard deadline builds"))
        .expect("the accessibility bus must be reachable");
    let outcomes = [
        ("files", run_leg(|| files(&bus, &connection))),
        ("terminal", run_leg(|| terminal(&bus, &connection))),
        ("calculator", run_leg(|| calculator(&bus, &connection))),
        ("qt", run_leg(|| qt(&bus, &connection))),
        ("vscode", run_leg(|| vscode(&bus, &connection))),
    ];
    let failures: Vec<String> = outcomes
        .into_iter()
        .filter_map(|(label, outcome)| outcome.err().map(|error| format!("[{label}] {error}")))
        .collect();
    assert!(failures.is_empty(), "{}", failures.join("\n\n"));
}

#[test]
fn settle_stops_at_once_when_the_watched_app_has_exited() {
    let mut launched = Launched::bare();
    let pid = launched
        .try_spawn("sh", &["-c", "echo no-module-named-pyqt6 >&2; exit 2"])
        .expect("sh starts");
    let started = Instant::now();
    let error = settle_watching(&SharedBus::default(), 1, Some(pid), || None)
        .err()
        .expect("an app that exited cannot settle");
    assert!(
        started.elapsed() < Duration::from_secs(10),
        "settle waited {:?} for an app that had exited",
        started.elapsed()
    );
    assert!(error.contains("no-module-named-pyqt6"), "{error}");
    assert!(error.contains("exit status: 2"), "{error}");
}
