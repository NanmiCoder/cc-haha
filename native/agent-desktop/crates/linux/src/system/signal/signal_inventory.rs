use crate::system::registry::app_outcome::AppOutcome;
use agent_desktop_core::{AdapterError, Deadline, WindowInfo};

use crate::system::focus::decide_focus;
use crate::system::focus::focus_world::focus_send;
use crate::system::registry::Registry;
use crate::system::registry::frame_read::FrameRead;
use crate::system::registry::listed_window::ListedWindow;
use crate::system::registry::registry_app::RegistryApp;
use crate::system::window::ghost_window::without_ghosts;
use crate::system::window::stopped_windows::of_stopped_apps;
use crate::system::window::window_ids::WindowIds;
use crate::system::window::window_listing::collect;
use crate::system::window::window_listing::read_frames;
use crate::system::x11::map::{ClientMatch, match_client};
use crate::system::x11::{self, DisplayReader, FrameFacts, X11Evidence, X11Source, X11State};
use crate::system::{
    SharedBus,
    menu::menu_focus,
    process::{liveness, proc_stat},
};
use crate::tree::AtspiElement;

/// One coherent read of the selected applications: their windows, how each
/// application's read went, and the focus decision over the same windows.
pub(crate) struct Pass {
    pub(crate) windows: Vec<ListedWindow>,
    pub(crate) outcomes: Vec<AppOutcome>,
    pub(crate) candidates: Vec<usize>,
    pub(crate) focused: Option<usize>,
    pub(crate) menu_focus_complete: bool,
    /// The selected applications whose windows the display server, not their
    /// own read, supplied because their process is stopped. What they present
    /// is known, so a pass that has them is not left wondering what they show.
    pub(crate) recovered: Vec<usize>,
}

impl Pass {
    /// The windows of the pass as they are reported, the focused one marked.
    pub(crate) fn infos(&self) -> Vec<WindowInfo> {
        self.windows
            .iter()
            .enumerate()
            .map(|(index, window)| {
                let mut info = window.info.clone();
                info.state.is_focused = self.focused == Some(index);
                info
            })
            .collect()
    }
}

/// The applications whose frames a pass reads, with their position in the
/// registry. An application that did not answer and is stopped is left out:
/// reading it costs a full slice and can only time out.
fn chosen_apps(
    registry: &Registry,
    select: impl Fn(&RegistryApp) -> bool,
    is_stopped: impl Fn(u32) -> bool,
) -> Vec<(usize, &RegistryApp)> {
    registry
        .apps
        .iter()
        .enumerate()
        .filter(|(_, app)| select(app))
        .filter(|(_, app)| app.answered || !is_stopped(app.root.pid()))
        .collect()
}

fn gather(
    chosen: &[(usize, &RegistryApp)],
    read: impl FnOnce(&[AtspiElement]) -> Result<Vec<FrameRead>, AdapterError>,
) -> Result<(Vec<ListedWindow>, Vec<AppOutcome>), AdapterError> {
    let roots: Vec<AtspiElement> = chosen.iter().map(|(_, app)| app.root.clone()).collect();
    let frames = read(&roots)?;
    let outcomes = chosen
        .iter()
        .zip(&frames)
        .map(|((app, _), frame)| AppOutcome {
            app: *app,
            read: frame.read,
        })
        .collect();
    let nodes: Vec<_> = frames.into_iter().map(|frame| frame.nodes).collect();
    Ok((collect(chosen, &nodes), outcomes))
}

/// The windows and per-application outcomes of the applications `select`
/// accepts, in registry order, without the display-server read.
pub(in crate::system) fn read_selected(
    bus: &SharedBus,
    registry: &Registry,
    select: impl Fn(&RegistryApp) -> bool,
    deadline: Deadline,
) -> Result<(Vec<ListedWindow>, Vec<AppOutcome>), AdapterError> {
    let (windows, outcomes) = read_unfiltered(bus, registry, select, deadline)?;
    Ok((without_ghosts(windows, &X11State::Unavailable), outcomes))
}

fn read_unfiltered(
    bus: &SharedBus,
    registry: &Registry,
    select: impl Fn(&RegistryApp) -> bool,
    deadline: Deadline,
) -> Result<(Vec<ListedWindow>, Vec<AppOutcome>), AdapterError> {
    let chosen = chosen_apps(registry, select, proc_stat::is_stopped);
    let (windows, outcomes) = gather(&chosen, |roots| read_frames(bus, roots, deadline))?;
    Ok((
        crate::system::window::window_filter::without_helpers(windows, deadline)?,
        outcomes,
    ))
}

/// Whether a selected, listable application has no outcome in the pass and no
/// windows the display server supplied for it: it was left unread because it
/// is stopped and its windows could not be told. What it presented is
/// unknown, so a capture that skipped it cannot say that its windows closed.
pub(crate) fn skipped_selected(
    registry: &Registry,
    pass: &Pass,
    select: impl Fn(&RegistryApp) -> bool,
) -> bool {
    registry.apps.iter().enumerate().any(|(index, app)| {
        select(app)
            && !pass.outcomes.iter().any(|outcome| outcome.app == index)
            && !pass.recovered.contains(&index)
    })
}

/// Keeps the id of each listed window against its X11 client, for the day its
/// process is stopped and can no longer be asked.
fn remember_ids(listed: &[ListedWindow], state: &X11State, ids: Option<&WindowIds>) {
    let (Some(ids), X11State::Ready { clients, .. }) = (ids, state) else {
        return;
    };
    for window in listed {
        let (ClientMatch::One(client), Some(instance)) = (
            match_client(&window.frame, clients),
            window.info.process_instance.as_deref(),
        ) else {
            continue;
        };
        ids.remember(client, instance, &window.info.id);
    }
}

/// The windows that could take focus: the ones that claim `ACTIVE`, minus
/// those the window manager does not manage at all. An override-redirect
/// popup takes `ACTIVE` while it grabs input but is no window a window
/// manager can make active, so with a client list to check it is no
/// candidate. Without one a claimed `ACTIVE` is all there is to go on.
fn candidates_of(windows: &[ListedWindow], state: &X11State) -> Vec<usize> {
    let managed = match state {
        X11State::Ready { clients, .. } if !clients.is_empty() => Some(clients),
        _ => None,
    };
    windows
        .iter()
        .enumerate()
        .filter(|(_, window)| window.active)
        .filter(|(_, window)| {
            managed
                .is_none_or(|clients| match_client(&window.frame, clients) != ClientMatch::NoClient)
        })
        .map(|(index, _)| index)
        .collect()
}

/// The window the sources agree is focused. A window counts when its frame
/// carries `ACTIVE`; so does a modal or dialog frame its toolkit never
/// reports active when the display server names its client the active
/// window and input focus lies in the client or one of its descendants.
fn focus_of(
    windows: &[ListedWindow],
    candidates: &[usize],
    state: &X11State,
    input_focus_in: impl Fn(u32) -> bool,
) -> Option<usize> {
    if candidates.is_empty() && !windows.iter().any(|window| window.modal || window.dialog) {
        return None;
    }
    let frames: Vec<FrameFacts> = windows.iter().map(|window| window.frame.clone()).collect();
    let evidence = x11::evidence(state, &frames);
    let mut candidates = candidates.to_vec();
    if let X11Evidence::Frame(named) = evidence
        && (windows[named].modal || windows[named].dialog)
        && !candidates.contains(&named)
        && let X11State::Ready {
            active: Some(client),
            ..
        } = state
        && input_focus_in(*client)
    {
        candidates.push(named);
    }
    decide_focus(&candidates, evidence)
}

/// The window a menu gives its application the focus for: the window manager
/// names a managed window active, no frame claims `ACTIVE` because the menu's
/// grab holds the keyboard, and the application owning that window has a menu
/// open. Only then is a window without an `ACTIVE` state a focus answer.
fn menu_focus_of(
    windows: &[ListedWindow],
    state: &X11State,
    menu_open: impl Fn(&WindowInfo) -> Result<bool, AdapterError>,
) -> Result<Option<usize>, AdapterError> {
    let frames: Vec<FrameFacts> = windows.iter().map(|window| window.frame.clone()).collect();
    let X11Evidence::Frame(named) = x11::evidence(state, &frames) else {
        return Ok(None);
    };
    menu_open(&windows[named].info).map(|open| open.then_some(named))
}

#[cfg(test)]
pub(in crate::system) fn pass_over(
    windows: Vec<ListedWindow>,
    outcomes: Vec<AppOutcome>,
    recovered: Vec<usize>,
    state: &X11State,
) -> Pass {
    pass_over_with_menu(
        windows,
        outcomes,
        recovered,
        state,
        |_| Ok(false),
        |_| false,
    )
}

pub(in crate::system) fn pass_over_with_menu(
    windows: Vec<ListedWindow>,
    outcomes: Vec<AppOutcome>,
    recovered: Vec<usize>,
    state: &X11State,
    menu_open: impl Fn(&WindowInfo) -> Result<bool, AdapterError>,
    input_focus_in: impl Fn(u32) -> bool,
) -> Pass {
    let candidates = candidates_of(&windows, state);
    let focused = focus_of(&windows, &candidates, state, input_focus_in);
    let from_menu = if focused.is_none() && candidates.is_empty() {
        menu_focus_of(&windows, state, menu_open)
    } else {
        Ok(None)
    };
    let menu_focus_complete = from_menu.is_ok();
    let focused = focused.or(from_menu.unwrap_or(None));
    Pass {
        windows,
        outcomes,
        candidates,
        focused,
        menu_focus_complete,
        recovered,
    }
}

/// A pass whose display-server read the caller already started: `finish`
/// waits for that read, and the state it came to comes back with the pass.
/// The stopped selected applications' windows are read back from the display
/// server, under the ids they were listed with while they still answered.
pub(in crate::system) fn run_pass_with(
    bus: &SharedBus,
    registry: &Registry,
    select: impl Fn(&RegistryApp) -> bool,
    finish: impl FnOnce(Deadline) -> X11State,
    deadline: Deadline,
) -> Result<(Pass, X11State), AdapterError> {
    let (windows, outcomes) = read_unfiltered(bus, registry, &select, deadline)?;
    let state = finish(deadline);
    let mut windows = without_ghosts(windows, &state);
    let ids = WindowIds::in_runtime_dir();
    remember_ids(&windows, &state, ids.as_ref());
    let stopped = of_stopped_apps(
        registry,
        &select,
        |pid, instance| liveness::liveness(pid, instance) == liveness::Liveness::Stopped,
        &state,
        |client, instance| ids.as_ref()?.recall(client, instance),
    );
    let mut recovered: Vec<usize> = stopped.iter().map(|window| window.app).collect();
    recovered.sort_unstable();
    recovered.dedup();
    windows.extend(stopped);
    Ok((
        pass_over_with_menu(
            windows,
            outcomes,
            recovered,
            &state,
            |window| menu_focus::open_for_window(bus, window, deadline),
            |client| focus_send::input_focus_in(client, deadline),
        ),
        state,
    ))
}

pub(crate) fn run_pass(
    bus: &SharedBus,
    registry: &Registry,
    select: impl Fn(&RegistryApp) -> bool,
    deadline: Deadline,
) -> Result<Pass, AdapterError> {
    let pending = x11::start(|| DisplayReader.read());
    let finish = |deadline| pending.finish(deadline).unwrap_or(X11State::Unavailable);
    run_pass_with(bus, registry, select, finish, deadline).map(|(pass, _)| pass)
}

#[cfg(test)]
#[path = "signal_inventory_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "signal_inventory_live_tests.rs"]
mod live_tests;
