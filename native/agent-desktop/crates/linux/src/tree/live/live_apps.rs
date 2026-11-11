use agent_desktop_core::Deadline;

use super::live_launch::{Launched, nonce, program_of};
use super::live_qt;
use super::live_tree::{frames_where, pid_frame};
use super::walker_live_tests::settle_watching;
use crate::LinuxAdapter;
use crate::system::SharedBus;
use crate::tree::AtspiElement;

const TERMINAL_SERVER: &str = "gnome-terminal-server";

/// What a live test does with one settled application window.
pub(in crate::tree) type Check =
    fn(&str, &LinuxAdapter, &SharedBus, &AtspiElement) -> Result<(), String>;

/// An application to launch and the settled node count to wait for.
pub(in crate::tree) struct AppSpec<'a> {
    pub(in crate::tree) label: &'a str,
    pub(in crate::tree) program: &'a str,
    pub(in crate::tree) arguments: &'a [&'a str],
    pub(in crate::tree) min_nodes: usize,
}

pub(in crate::tree) fn app(
    spec: &AppSpec,
    adapter: &LinuxAdapter,
    bus: &SharedBus,
    check: Check,
) -> Result<(), String> {
    let AppSpec {
        label,
        program,
        arguments,
        min_nodes,
    } = *spec;
    let connection = bus
        .get(Deadline::standard().map_err(|error| error.message)?)
        .map_err(|error| error.message)?;
    let mut launched = Launched::new();
    let pid = launched.try_spawn(program, arguments)?;
    let settled = settle_watching(bus, min_nodes, Some(pid), || pid_frame(&connection, pid))
        .map_err(|error| format!("[{label}] {error}"))?;
    check(label, adapter, bus, &settled.frame)
}

pub(in crate::tree) fn terminal(
    adapter: &LinuxAdapter,
    bus: &SharedBus,
    check: Check,
) -> Result<(), String> {
    let connection = bus
        .get(Deadline::standard().map_err(|error| error.message)?)
        .map_err(|error| error.message)?;
    let is_server = |pid: u32| program_of(pid).as_deref() == Some(TERMINAL_SERVER);
    let known = frames_where(&connection, is_server);
    let mut launched = Launched::new();
    let guard = std::env::temp_dir().join(nonce("resolve-terminal"));
    std::fs::create_dir_all(&guard).map_err(|error| error.to_string())?;
    launched.scratch.push(guard.clone());
    let script = format!(
        "while [ -d '{}' ] && kill -0 {} 2>/dev/null; do sleep 0.5; done",
        guard.display(),
        std::process::id()
    );
    let client = launched.try_spawn("gnome-terminal", &["--wait", "--", "bash", "-c", &script])?;
    let settled = settle_watching(bus, 20, Some(client), || {
        frames_where(&connection, is_server)
            .into_iter()
            .find(|frame| {
                !known
                    .iter()
                    .any(|old| old.path() == frame.path() && old.bus_name() == frame.bus_name())
            })
    })
    .map_err(|error| format!("[terminal] {error}"))?;
    check("terminal", adapter, bus, &settled.frame)
}

pub(in crate::tree) fn qt(
    adapter: &LinuxAdapter,
    bus: &SharedBus,
    check: Check,
) -> Result<(), String> {
    let connection = bus
        .get(Deadline::standard().map_err(|error| error.message)?)
        .map_err(|error| error.message)?;
    let mut launched = Launched::new();
    let pid = live_qt::launch(&mut launched)?;
    let settled = settle_watching(bus, 15, Some(pid), || pid_frame(&connection, pid))
        .map_err(|error| format!("[qt] {error}"))?;
    check("qt", adapter, bus, &settled.frame)
}
