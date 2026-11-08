use std::time::Duration;

use agent_desktop_core::{
    AdapterError, Deadline, DeliverySemantics, ErrorCode, InteractionLease, OperationReport,
    OperationTarget, Rect, WindowInfo, WindowOp,
};
use serde_json::Value;

use self::hold::{
    confirm_rectangle, give_back_place, holds_place, is_resize, move_client, remember_place,
};
use self::owner::{ensure_owned_after, ensure_owned_before};
use self::refuse::{no_client, refused, unreadable, unsupported_session, write_failed};
use self::window_place::PlaceStore;
use super::window_client::{ClientWorld, client_of};
use super::window_op::window_op_shadow::{Shadow, to_client, to_visible, visible_of};
use super::window_op::window_op_verdict::{
    POLL, POSITION_TOLERANCE, SETTLE_BUDGET, Verdict, judge, observed_of, requested, unverified,
};
use crate::system::display::display_server::{DisplayServer, session_server};
use crate::system::focus::focus_cause::Cause;
use crate::system::focus::focus_window::FocusWorld;
use crate::system::focus::focus_world::LiveWorld as FrameWorld;
use crate::system::focus::restore_minimized::{Lifted, lift, still_hidden};
use crate::system::process::process_lookup::Lookup;
use crate::system::x11::control::control_error::ControlError;
use crate::system::x11::control::control_send::{WindowWrite, write_window};
use crate::system::x11::control::window_facts::{WindowFacts, read_facts};
use crate::system::x11::control::{ControlRead, xwayland_clients};
use crate::system::x11::stacking::stacking_source::StackingSource;
use crate::system::x11::twin_tie::Twins;
use crate::system::x11::{DisplayReader, X11Client, X11State};
use crate::system::{
    SharedBus, list_displays,
    process::{proc_stat, process_facts},
};
use crate::tree::Extents;

const CONFIRM_PAUSE: Duration = Duration::from_millis(120);
const NUDGE: i32 = 40;

/// What a window operation reads and writes, so the decision can be driven by
/// a fixed desktop.
trait OpWorld: ClientWorld {
    fn lookup(&self, pid: u32) -> Lookup;
    fn stopped(&self, pid: u32) -> bool;
    fn clients(&self) -> ControlRead<Vec<X11Client>>;
    /// The client the window manager reports active.
    fn active_client(&self) -> Option<u32>;
    fn facts(&self, client: u32) -> ControlRead<WindowFacts>;
    fn write(&self, client: u32, write: &WindowWrite) -> Result<(), ControlError>;
    fn lift(&self, client: u32) -> Result<Lifted, AdapterError>;
    /// Whether GNOME Shell reports its Activities Overview open; read once,
    /// for a restore the manager refused.
    fn overview_open(&self) -> Option<bool>;
    fn displays(&self) -> Vec<Rect>;
    fn on_wayland(&self) -> bool;
    fn remember(&self, win: &WindowInfo, client: u32, rectangle: Option<Extents>);
    fn remembered(&self, win: &WindowInfo, client: u32) -> Option<Extents>;
}

struct Live<'a> {
    frame: FrameWorld<'a>,
    owner: agent_desktop_core::ProcessIdentity,
    deadline: Deadline,
}

impl ClientWorld for Live<'_> {
    fn global_position(&self) -> bool {
        self.frame.global_position()
    }

    fn twins(&self, win: &WindowInfo) -> Option<Twins> {
        self.frame.twins(win)
    }
}

impl OpWorld for Live<'_> {
    fn lookup(&self, pid: u32) -> Lookup {
        process_facts::lookup(pid)
    }

    fn stopped(&self, pid: u32) -> bool {
        proc_stat::is_stopped(pid)
    }

    fn clients(&self) -> ControlRead<Vec<X11Client>> {
        match session_server() {
            DisplayServer::X11(_) => match DisplayReader.clients_within(self.deadline) {
                X11State::Ready { clients, .. } => ControlRead::Ready(clients),
                X11State::NoWindowManager => ControlRead::NoManager,
                X11State::Unavailable => ControlRead::Unavailable,
            },
            DisplayServer::Wayland => xwayland_clients(self.deadline),
            DisplayServer::Unavailable(..) => ControlRead::Unavailable,
        }
    }

    fn active_client(&self) -> Option<u32> {
        self.frame.active()
    }

    fn on_wayland(&self) -> bool {
        session_server() == DisplayServer::Wayland
    }

    fn facts(&self, client: u32) -> ControlRead<WindowFacts> {
        read_facts(client, &self.owner, self.deadline)
    }

    fn write(&self, client: u32, write: &WindowWrite) -> Result<(), ControlError> {
        write_window(client, write, &self.owner, self.deadline)
    }

    fn lift(&self, client: u32) -> Result<Lifted, AdapterError> {
        lift(client, &self.owner, self.deadline)
    }

    fn overview_open(&self) -> Option<bool> {
        self.frame.overview_open()
    }

    fn remember(&self, win: &WindowInfo, client: u32, rectangle: Option<Extents>) {
        let (Some(store), Some(instance)) = (
            PlaceStore::in_runtime_dir(),
            win.process_instance.as_deref(),
        ) else {
            return;
        };
        match rectangle {
            Some(place) => {
                let alive = |pid: u32, instance: &str| matches!(process_facts::lookup(pid), Lookup::Found(facts) if facts.instance == instance);
                let _ = store.save(client, win.pid.get(), instance, place, &alive);
            }
            None => store.forget(client, instance),
        }
    }

    fn remembered(&self, win: &WindowInfo, client: u32) -> Option<Extents> {
        PlaceStore::in_runtime_dir()?.load(client, win.process_instance.as_deref()?)
    }

    fn displays(&self) -> Vec<Rect> {
        list_displays(self.deadline)
            .map(|displays| displays.into_iter().map(|display| display.bounds).collect())
            .unwrap_or_default()
    }
}

fn locate(world: &impl OpWorld, win: &WindowInfo) -> Result<(u32, Shadow), AdapterError> {
    let read = world.clients();
    let ControlRead::Ready(clients) = &read else {
        if world.on_wayland() {
            return Err(unsupported_session(&ControlRead::NotX11));
        }
        return Err(unsupported_session(&read));
    };
    let id = client_of(world, win, clients, || world.active_client()).map_err(|cause| {
        if cause == Cause::WindowNotMapped && world.on_wayland() {
            unsupported_session(&ControlRead::NotX11)
        } else {
            no_client(cause)
        }
    })?;
    let shadow = clients
        .iter()
        .find(|client| client.id == id)
        .map_or((0, 0, 0, 0), |client| client.shadow);
    Ok((id, shadow))
}

fn settle(
    world: &impl OpWorld,
    client: u32,
    write: &WindowWrite,
    deadline: Deadline,
) -> (Verdict, Option<WindowFacts>) {
    let limit = deadline.capped(SETTLE_BUDGET);
    loop {
        let mut observed = world.facts(client).ready();
        let at_limit = limit.is_expired();
        let verdict = match observed {
            Some(facts) => judge(write, &facts, at_limit),
            None if at_limit => Verdict::Mismatch,
            None => Verdict::Pending,
        };
        match verdict {
            Verdict::Satisfied if matches!(write, WindowWrite::MoveResize { .. }) => {
                if limit.remaining() < CONFIRM_PAUSE {
                    return (Verdict::Mismatch, observed);
                }
                let Some(first) = observed else {
                    return (Verdict::Mismatch, None);
                };
                let (stable, latest) = confirm_rectangle(world, client, first, limit);
                observed = latest;
                match observed {
                    Some(facts) if stable && judge(write, &facts, true) == Verdict::Satisfied => {
                        return (Verdict::Satisfied, Some(facts));
                    }
                    _ if limit.is_expired() => return (Verdict::Mismatch, observed),
                    _ => {}
                }
            }
            Verdict::Pending => {}
            _ => return (verdict, observed),
        }
        std::thread::sleep(POLL.min(limit.remaining()));
    }
}

fn apply(
    world: &impl OpWorld,
    win: &WindowInfo,
    client: u32,
    write: &WindowWrite,
    deadline: Deadline,
) -> Result<(), AdapterError> {
    if *write == WindowWrite::SetMaximized(true) {
        remember_place(world, win, client);
    }
    let before = if is_resize(write) {
        world.facts(client).ready().map(|facts| facts.client)
    } else {
        None
    };
    world.write(client, write).map_err(write_failed)?;
    let (verdict, observed) = settle(world, client, write, deadline);
    ensure_owned_after(world, win, client)?;
    let outcome = match verdict {
        Verdict::Satisfied => Ok(()),
        Verdict::Pending | Verdict::Mismatch => {
            let displays = world.displays();
            Err(unverified(write, observed.as_ref(), &displays))
        }
    };
    if let (Some(place), Some(facts)) = (before, observed)
        && holds_place(&place, &facts.client, &world.displays())
        && ((facts.client.x - place.x).abs() > POSITION_TOLERANCE
            || (facts.client.y - place.y).abs() > POSITION_TOLERANCE)
    {
        let _ = move_client(world, win, client, place, deadline);
    }
    outcome.map_err(|error| reobserve(world, client, error))
}

fn read_before(world: &impl OpWorld, client: u32) -> Result<WindowFacts, AdapterError> {
    match world.facts(client) {
        ControlRead::Ready(facts) => Ok(facts),
        _ => Err(unreadable()),
    }
}

fn restore(
    world: &impl OpWorld,
    win: &WindowInfo,
    client: u32,
    deadline: Deadline,
) -> Result<(), AdapterError> {
    let mut current = read_before(world, client)?;
    if current.hidden && world.on_wayland() {
        return Err(refused(
            ErrorCode::ActionNotSupported,
            "wayland_session",
            "A Wayland compositor refuses to show a minimized window for another client",
            "Show the window yourself, for example from the overview",
        ));
    }
    if current.hidden {
        if let Lifted::StillHidden { manager } = world.lift(client)? {
            return Err(still_hidden(&manager, world.overview_open() == Some(true)));
        }
        current = read_before(world, client)
            .map_err(|error| error.with_disposition(DeliverySemantics::delivered_unverified()))?;
    }
    if !current.maximized_vertical && !current.maximized_horizontal {
        return give_back_place(world, win, client, deadline);
    }
    apply(
        world,
        win,
        client,
        &WindowWrite::SetMaximized(false),
        deadline,
    )?;
    give_back_place(world, win, client, deadline)
}

fn reobserve(world: &impl OpWorld, client: u32, mut error: AdapterError) -> AdapterError {
    let (ControlRead::Ready(facts), Some(observed)) = (
        world.facts(client),
        error
            .details
            .as_mut()
            .and_then(|details| details.get_mut("observed"))
            .filter(|observed| observed.is_object()),
    ) else {
        return error;
    };
    *observed = observed_of(Some(&facts));
    error
}

fn dispatch(
    world: &impl OpWorld,
    win: &WindowInfo,
    op: &WindowOp,
    deadline: Deadline,
) -> Result<Option<Value>, AdapterError> {
    let write = requested(op)?;
    ensure_owned_before(world, win)?;
    if world.stopped(win.pid.get()) {
        return Err(AdapterError::app_unresponsive(&win.app)
            .with_disposition(DeliverySemantics::not_delivered()));
    }
    let (client, shadow) = locate(world, win)?;
    if deadline.is_expired() {
        return Err(deadline
            .timeout_error()
            .with_disposition(DeliverySemantics::not_delivered()));
    }
    let done = match write {
        Some(write) => apply(world, win, client, &to_client(write, shadow), deadline),
        None => restore(world, win, client, deadline),
    };
    done.map(|()| match op {
        WindowOp::Resize { .. } => world
            .facts(client)
            .ready()
            .map(|facts| visible_of(observed_of(Some(&facts)), shadow)),
        _ => None,
    })
    .map_err(|error| to_visible(error, shadow))
}

fn run(
    world: &impl OpWorld,
    win: &WindowInfo,
    op: &WindowOp,
    deadline: Deadline,
) -> Result<OperationReport, AdapterError> {
    let dispatched = dispatch(world, win, op, deadline);
    let observed = dispatched.as_ref().ok().cloned().flatten();
    let mut report = OperationReport::from_window_dispatch(
        win,
        op,
        super::window_report::window_readback(op),
        dispatched.map(drop),
    )?;
    if let (Some(observed), Some(Value::Object(details))) =
        (observed, report.result.details.as_mut())
    {
        details.insert("observed".to_owned(), observed);
    }
    Ok(report)
}

pub(crate) fn window_op(
    bus: &SharedBus,
    win: &WindowInfo,
    op: WindowOp,
    lease: &InteractionLease,
) -> Result<OperationReport, AdapterError> {
    OperationTarget::for_window(win)?;
    let deadline = lease.deadline();
    let frame = FrameWorld::new(bus, win, deadline)
        .map_err(|error| error.with_disposition(DeliverySemantics::not_delivered()))?;
    let owner = agent_desktop_core::ProcessIdentity::new(
        win.pid,
        win.process_instance.clone().unwrap_or_default(),
    );
    run(
        &Live {
            frame,
            owner,
            deadline,
        },
        win,
        &op,
        deadline,
    )
}

#[path = "window_op_hold.rs"]
mod hold;
#[path = "window_op_owner.rs"]
mod owner;
#[path = "window_op_refuse.rs"]
mod refuse;
pub(in crate::system) mod window_op_shadow;
pub(in crate::system) mod window_op_verdict;
#[path = "window_place.rs"]
mod window_place;

#[cfg(test)]
#[path = "window_op_tests.rs"]
mod tests;
