use std::collections::HashSet;
use std::time::Duration;

use agent_desktop_core::system::launch_options::LaunchOptions;
use agent_desktop_core::system::launch_result::LaunchResult;
use agent_desktop_core::{
    AdapterError, Deadline, DeliverySemantics, ErrorCode, InteractionLease, ProcessId,
    RendererKind, WindowInfo,
};

use self::launch_attach::{Decision, decide};
use self::launch_observe::{POLL_INTERVAL, Spawned, find_owner, pids_of, running_of};
use self::launch_search::Search;
use self::launch_spawn::{before_spawn, spawn, validate};
use self::launch_target::{Plan, resolve};
use super::SharedBus;
use crate::system::app::app_alias::current_index;
use crate::system::focus::focus_window::focus_window;
use crate::system::process::liveness::{Liveness, liveness};
use crate::system::process::process_facts;
use crate::system::process::running_app::Running;
use crate::system::process::web_family::WebFamily;
use crate::system::window::native_group::is_unproven;
use crate::system::window::window_ops::windows_of_process;

#[path = "launch_baseline.rs"]
mod baseline;

fn bounded(deadline: Deadline, timeout_ms: u64) -> Deadline {
    if timeout_ms == 0 {
        deadline
    } else {
        deadline.capped(Duration::from_millis(timeout_ms))
    }
}

fn chromium_renderer(bus: &SharedBus, pid: u32, deadline: Deadline) -> Option<RendererKind> {
    super::registry::read_registry_for(bus, Some(pid), deadline)
        .ok()?
        .apps
        .iter()
        .any(|app| {
            crate::tree::properties::toolkit_trust::web_family(&app.toolkit)
                == Some(WebFamily::Chromium)
        })
        .then_some(RendererKind::Chromium)
}

/// The window with `id` among a fresh read of the owner's windows, so a result
/// keeps the window the launch chose and focused, not the first one listed.
fn same_window(windows: Vec<WindowInfo>, id: &str) -> Option<WindowInfo> {
    windows.into_iter().find(|window| window.id == id)
}

/// The result for an owner and its window. A window is brought forward once,
/// only when asked, and a refusal is reported in the suggestion because the
/// launch itself succeeded. A successful `focus` returns the window read after
/// the request, or `None` when no such read is available, and that window
/// replaces the one read before it.
fn conclude(
    owner: &Running,
    window: Option<WindowInfo>,
    options: &LaunchOptions,
    created: bool,
    focus: impl FnOnce(&WindowInfo) -> Result<Option<WindowInfo>, AdapterError>,
) -> LaunchResult {
    let mut notes = Vec::new();
    let mut window = window;
    if !created && (!options.env.is_empty() || options.cwd.is_some()) {
        notes.push(
            "A running instance was used, so the environment and working directory of this launch were not applied.".to_owned(),
        );
    }
    if options.activate
        && let Some(target) = &window
    {
        match focus(target) {
            Ok(reread) => window = reread.or(window),
            Err(error) => notes.push(format!(
                "The window could not be brought forward: {}",
                error.message
            )),
        }
    }
    LaunchResult {
        app: owner.name.clone(),
        pid: ProcessId::new(owner.pid),
        process_instance: Some(owner.instance.clone()),
        window,
        cdp: None,
        renderer: None,
        suggestion: (!notes.is_empty()).then(|| notes.join(" ")),
    }
}

/// The refusal for an application that was on the registry and left before it
/// showed a window: reporting its pid as a launch would hand the caller a dead
/// process.
fn exited_early(owner: &Running, liveness: Liveness) -> Result<(), AdapterError> {
    if liveness != Liveness::Gone {
        return Ok(());
    }
    Err(AdapterError::new(
        ErrorCode::ActionFailed,
        format!(
            "'{}' (pid {}) exited before it showed a window",
            owner.name, owner.pid
        ),
    )
    .with_suggestion("Run the program from a terminal to see why it stopped, then launch it again.")
    .with_disposition(DeliverySemantics::delivered_unverified()))
}

/// The refusal a launch ends on when the deadline passed with no window
/// proven. An application the launch started has been delivered to, whatever
/// the read could prove.
fn unproven_at_deadline(error: AdapterError, started: bool) -> AdapterError {
    let error = error.with_suggestion(
        "Run 'list-windows' to see whether the window of the application is open.",
    );
    if started {
        error.with_disposition(DeliverySemantics::delivered_unverified())
    } else {
        before_spawn(error)
    }
}

/// The window a launch reports among the windows of its application: one
/// that was not open before the launch, or, for an application the launch
/// started, its first. A window that was already open is not the launch's.
fn choose_window(own: Vec<WindowInfo>, known: &HashSet<String>) -> Option<WindowInfo> {
    own.into_iter().find(|window| !known.contains(&window.id))
}

/// How long a launch that was not asked to bring the window forward waits for
/// the first window of an application it started.
const WINDOW_GRACE: Duration = Duration::from_millis(2_000);

/// How long such a launch waits for the new window of an application that
/// was already running and forwarded the request.
const NEW_WINDOW_WAIT: Duration = Duration::from_millis(5_000);

struct Launch<'a> {
    bus: &'a SharedBus,
    id: &'a str,
    options: &'a LaunchOptions,
    lease: &'a InteractionLease,
    deadline: Deadline,
}

impl Launch<'_> {
    fn window_of(
        &self,
        owner: &Running,
        waits: bool,
        known: &HashSet<String>,
    ) -> Result<Option<WindowInfo>, AdapterError> {
        self.wait_for_window(owner, waits, known, || {
            windows_of_process(self.bus, owner.pid, self.deadline)
        })
    }

    /// Reads the owner's windows until one is reported. `waits` is true for an
    /// application this launch spawned: the read goes on for a window and ends
    /// if the owner exits. An attach passes false and reads only until it has
    /// an answer. A read that could not prove a window is read again until the
    /// launch deadline.
    fn wait_for_window(
        &self,
        owner: &Running,
        waits: bool,
        known: &HashSet<String>,
        mut read: impl FnMut() -> Result<Vec<WindowInfo>, AdapterError>,
    ) -> Result<Option<WindowInfo>, AdapterError> {
        let limit = self.wait_limit(known);
        let mut unproven = None;
        loop {
            match read() {
                Ok(windows) => {
                    unproven = None;
                    let own: Vec<WindowInfo> = windows
                        .into_iter()
                        .filter(|window| {
                            window.pid.get() == owner.pid
                                && window.process_instance.as_deref()
                                    == Some(owner.instance.as_str())
                        })
                        .collect();
                    if let Some(window) = choose_window(own, known) {
                        return Ok(Some(window));
                    }
                }
                Err(error) if is_unproven(&error) => unproven = Some(error),
                Err(error)
                    if matches!(
                        error.code,
                        ErrorCode::Timeout
                            | ErrorCode::AppUnresponsive
                            | ErrorCode::AppNotFound
                            | ErrorCode::WindowNotFound
                    ) => {}
                Err(error) => {
                    return Err(error.with_disposition(DeliverySemantics::delivered_unverified()));
                }
            }
            if waits {
                exited_early(owner, liveness(owner.pid, &owner.instance))?;
            }
            let until = if unproven.is_some() {
                self.deadline
            } else {
                limit
            };
            if until.is_expired() || (unproven.is_none() && !waits) {
                return unproven.map_or(Ok(None), |error| Err(unproven_at_deadline(error, waits)));
            }
            std::thread::sleep(POLL_INTERVAL.min(until.remaining()));
        }
    }

    fn wait_limit(&self, known: &HashSet<String>) -> Deadline {
        if self.options.activate {
            return self.deadline;
        }
        let wait = if known.is_empty() {
            WINDOW_GRACE
        } else {
            NEW_WINDOW_WAIT
        };
        self.deadline.capped(wait)
    }

    fn conclude_with(
        &self,
        owner: &Running,
        window: Option<WindowInfo>,
        created: bool,
    ) -> LaunchResult {
        LaunchResult {
            renderer: chromium_renderer(self.bus, owner.pid, self.deadline),
            ..conclude(owner, window, self.options, created, |window| {
                focus_window(self.bus, window, self.lease)?;
                Ok(windows_of_process(self.bus, owner.pid, self.deadline)
                    .ok()
                    .and_then(|windows| same_window(windows, &window.id)))
            })
        }
    }

    /// A running application is reported with its window. One that shows no
    /// window, such as a file manager that stays resident after its last
    /// window closed, is started again so that its launcher forwards to it
    /// and a window opens.
    fn attach(
        &self,
        owner: &Running,
        plan: &Plan,
        identity: &Option<crate::system::process::executable_identity::ExecutableIdentity>,
        running: &[Running],
    ) -> Result<LaunchResult, AdapterError> {
        match self.window_of(owner, false, &HashSet::new())? {
            Some(window) => Ok(self.conclude_with(owner, Some(window), false)),
            None => self.start(plan, identity, running),
        }
    }

    fn report_unlisted(&self, spawned: &Spawned) -> LaunchResult {
        let facts = process_facts::read(spawned.pid);
        LaunchResult {
            app: facts
                .as_ref()
                .map_or_else(|| self.id.to_owned(), super::listed_app_name),
            pid: ProcessId::new(spawned.pid),
            process_instance: facts.map(|facts| facts.instance),
            window: None,
            cdp: None,
            renderer: None,
            suggestion: Some(
                "The process started but is not on the accessibility bus yet. Its pid is the spawned process's and may be a wrapper of the application. Run 'list-apps' to see whether it appears.".to_owned(),
            ),
        }
    }

    fn start(
        &self,
        plan: &Plan,
        identity: &Option<crate::system::process::executable_identity::ExecutableIdentity>,
        running: &[Running],
    ) -> Result<LaunchResult, AdapterError> {
        let before = baseline::prepare(self.bus, identity, running, self.deadline);
        self.deadline.ensure_remaining().map_err(before_spawn)?;
        let mut spawned = spawn(self.id, plan, self.options)?;
        match find_owner(self.bus, &mut spawned, identity, &before, self.deadline)? {
            Some(owner) => {
                let known = before
                    .residents
                    .iter()
                    .find(|(resident, _)| resident.identity() == owner.identity());
                let window = match known {
                    Some((_, windows)) => self.window_of(&owner, true, windows)?,
                    None if before.processes.contains(&owner.identity()) => None,
                    None => self.window_of(&owner, true, &HashSet::new())?,
                };
                Ok(self.conclude_with(&owner, window, owner.pid == spawned.pid))
            }
            None => Ok(self.report_unlisted(&spawned)),
        }
    }
}

/// Starts an application by command name, absolute path, desktop id or
/// desktop entry name, or attaches to the running one, and reports the pid of
/// the application that owns the windows with its first window. The attach
/// decision is made before anything is spawned.
pub(crate) fn launch_app(
    bus: &SharedBus,
    id: &str,
    options: &LaunchOptions,
    lease: &InteractionLease,
) -> Result<LaunchResult, AdapterError> {
    validate(options)?;
    let deadline = bounded(lease.deadline(), options.timeout_ms);
    let search = Search::from_env();
    let plan = resolve(id, &options.args, &search, &current_index())?;
    let registry = crate::system::registry::read_processes(bus, deadline).map_err(before_spawn)?;
    let running = running_of(&registry).map_err(before_spawn)?;
    let launch = Launch {
        bus,
        id,
        options,
        lease,
        deadline,
    };
    match decide(
        &plan.identity,
        &running,
        options.attach_if_running,
        !options.args.is_empty(),
    ) {
        Decision::Refuse(pids) => Err(before_spawn(
            AdapterError::new(
                ErrorCode::ActionFailed,
                format!("'{id}' is already running (pids {pids:?}) and a new launch was required"),
            )
            .with_suggestion("Allow attaching to use the running instance, or close it first."),
        )),
        Decision::Ambiguous(pids) => Err(AdapterError::ambiguous_process_target(
            format!("'{id}' matches several running applications"),
            &pids_of(&pids),
        )),
        Decision::Attach(owner) => launch.attach(&owner, &plan, &plan.identity, &running),
        Decision::Forward | Decision::Spawn => launch.start(&plan, &plan.identity, &running),
    }
}

#[cfg(test)]
#[path = "launch_tests.rs"]
mod tests;
#[cfg(test)]
#[path = "launch_window_tests.rs"]
mod window_tests;

pub(super) mod desktop_entry;
pub(crate) mod desktop_entry_traits;
pub(super) mod desktop_exec;
pub(super) mod desktop_lookup;
pub(super) mod desktop_stamp;
pub(super) mod indexed_entry;
pub(super) mod launch_attach;
mod launch_handoff;
#[cfg(test)]
pub(super) mod launch_live_tests;
pub(super) mod launch_observe;
pub(crate) mod launch_sample;
pub(crate) mod launch_search;
mod launch_spawn;
pub(crate) mod launch_step;
pub(super) mod launch_target;
