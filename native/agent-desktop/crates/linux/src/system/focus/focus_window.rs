use crate::system::focus::focus_client_view::ClientView;
use crate::system::focus::focus_frame_view::FrameView;
use std::time::Duration;

use agent_desktop_core::{AdapterError, Deadline, DeliverySemantics, InteractionLease, WindowInfo};

use crate::system::process::process_lookup::Lookup;
use crate::system::window::window_op::window_op_verdict::POLL;
use crate::system::x11::X11State;
use crate::system::x11::control::activate::ACTIVATION_GRACE;
use crate::system::x11::control::activate_error::ActivateError;
use crate::system::x11::control::control_error::ControlError;
use crate::system::x11::stacking::stacking_read::StackingRead;
use crate::system::{SharedBus, shell, window::window_id};

use super::focus_cause::{Cause, lift_refusal, modal_refusal, refusal};
use super::focus_world;
use super::restore_minimized::Lifted;
use crate::system::window::window_client::{ClientWorld, client_of};
use crate::system::x11::window::desktop_placement::DesktopPlacement;

const FIRST_LOOK: Duration = Duration::from_millis(100);

/// How long a frame gets to report itself active once the window manager
/// already names it. Chromium and Electron report it after their own focus
/// event, which took 1.8 s on an idle box and more on a loaded one.
const FRAME_REPORT_GRACE: Duration = Duration::from_millis(6_000);

/// Which display server the session uses.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(in crate::system) enum Session {
    X11,
    Wayland,
    NoDisplay,
}

/// Everything `focus_window` reads and writes, so the decision can be driven
/// by a fixed desktop.
pub(in crate::system) trait FocusWorld: ClientWorld {
    fn session(&self) -> Session;
    fn lookup(&self, pid: u32) -> Lookup;
    fn frame(&self) -> Result<FrameView, AdapterError>;
    fn clients(&self) -> X11State;
    fn stacking(&self, client: u32) -> StackingRead;
    fn send(&self, client: u32) -> Result<(), ControlError>;
    fn active(&self) -> Option<u32>;
    fn lift(&self, client: u32) -> Result<Lifted, AdapterError>;
    fn stopped(&self, pid: u32) -> bool;
    fn send_untimed(&self, client: u32) -> Result<(), ControlError>;
    fn switch_desktop(&self, desktop: u32) -> Result<(), ActivateError>;
    fn modal_over(&self, client: u32) -> Option<String>;
    fn input_focus_in(&self, client: u32) -> bool;
    fn menu_open(&self) -> bool;
    /// Whether any accessibility frame owned by this process reports ACTIVE.
    /// Chromium can move ACTIVE from its main frame to an application-owned
    /// popup while the X11 window manager continues to name the main client.
    fn app_frame_active(&self) -> bool;
    fn overview_open(&self) -> Option<bool>;
    fn arm_wake(&self) {}
    fn wait_for_change(&self, deadline: Deadline) {
        std::thread::sleep(deadline.remaining());
    }
}

fn check_process(world: &impl FocusWorld, win: &WindowInfo) -> Result<(), AdapterError> {
    match world.lookup(win.pid.get()) {
        Lookup::Found(facts) if win.process_instance.as_deref() != Some(&facts.instance) => Err(
            AdapterError::stale_ref_because("The window belongs to a different process instance"),
        ),
        Lookup::Gone => Err(AdapterError::stale_ref_because(
            "The window's process has exited",
        )),
        Lookup::Found(_) | Lookup::Unreadable => Ok(()),
    }
}

fn client_view(world: &impl FocusWorld, client: u32) -> Result<ClientView, Cause> {
    let StackingRead::Ready(snapshot) = world.stacking(client) else {
        return Err(Cause::X11Unavailable);
    };
    let window = snapshot
        .stack
        .iter()
        .find(|window| window.id == client)
        .ok_or(Cause::X11Unavailable)?;
    let other_desktop = match (window.desktop, snapshot.current_desktop) {
        (DesktopPlacement::On(desktop), Some(current)) if desktop != current => Some(desktop),
        _ => None,
    };
    if other_desktop.is_none() && !window.flags.hidden && !window.flags.mapped {
        return Err(Cause::WindowNotMapped);
    }
    Ok(ClientView {
        hidden: window.flags.hidden && other_desktop.is_none(),
        other_desktop,
    })
}

/// Whether the window is active by both measures. A dialog that its toolkit
/// marks modal or presents as a dialog frame and never reports active has no
/// frame measure to give; for it the display server naming the window active
/// and the input focus lying in it are the evidence.
fn is_active(world: &impl FocusWorld, client: u32) -> (Option<u32>, bool) {
    let active = world.active();
    if active != Some(client) {
        return (active, false);
    }
    let view = world.frame().ok();
    let reported = view.and_then(|view| view.active) == Some(true) || world.app_frame_active();
    let silent_dialog = view
        .is_some_and(|view| (view.modal == Some(true) || view.dialog) && view.active != Some(true));
    let done = reported || world.menu_open() || (silent_dialog && world.input_focus_in(client));
    (active, done)
}

fn timeout_cause(before: Option<u32>, after: Option<u32>, client: u32) -> Cause {
    match (before, after) {
        (_, Some(now)) if now == client => Cause::FrameNotActive,
        (None, None) => Cause::ActivationNotGranted,
        _ => Cause::ActivationRefused,
    }
}

/// Polls until the window is active by both measures. With `first_look`, a
/// request the manager has not acted on by then, the display server still
/// naming another window, ends the wait early: a granted request shows
/// within tens of milliseconds, so the wait that follows is spent on the
/// resend and not on a request nobody is acting on. A window the manager
/// already names gets the longer frame deadline to report itself active.
fn wait_for_focus(
    world: &impl FocusWorld,
    client: u32,
    before: Option<u32>,
    (deadline, frame_deadline): (Deadline, Deadline),
    first_look: Option<Duration>,
) -> Result<(), Cause> {
    let started = std::time::Instant::now();
    loop {
        let (active, done) = is_active(world, client);
        if done {
            return Ok(());
        }
        let unanswered =
            active != Some(client) && first_look.is_some_and(|look| started.elapsed() >= look);
        let waiting_for_the_frame = active == Some(client) && !frame_deadline.is_expired();
        if (deadline.is_expired() || unanswered) && !waiting_for_the_frame {
            return Err(timeout_cause(before, active, client));
        }
        let phase_deadline = if active == Some(client) {
            frame_deadline
        } else {
            deadline
        };
        world.wait_for_change(phase_deadline.capped(POLL));
    }
}

fn overview_aware(world: &impl FocusWorld, cause: Cause) -> Cause {
    if world.overview_open() == Some(true) {
        Cause::OverviewOpen
    } else {
        cause
    }
}

fn ask_and_wait(
    world: &impl FocusWorld,
    client: u32,
    before: Option<u32>,
    deadline: Deadline,
    untimed: bool,
) -> Result<(), AdapterError> {
    world.arm_wake();
    let sent = if untimed {
        world.send_untimed(client)
    } else {
        world.send(client)
    };
    sent.map_err(|error| match error {
        ControlError::StaleWindow => AdapterError::stale_ref_because(
            "The activation target's window owner or process instance changed or could not be verified",
        ),
        ControlError::SendFailed => refusal(Cause::ActivationNotSent)
            .with_disposition(DeliverySemantics::uncertain()),
        _ => refusal(Cause::ActivationNotSent),
    })?;
    let first_look = (!untimed).then_some(FIRST_LOOK);
    let deadlines = (
        deadline.capped(ACTIVATION_GRACE),
        deadline.capped(FRAME_REPORT_GRACE),
    );
    match wait_for_focus(world, client, before, deadlines, first_look) {
        Ok(()) => Ok(()),
        Err(cause) => Err(match world.modal_over(client) {
            Some(dialog) => modal_refusal(&dialog),
            None => refusal(overview_aware(world, cause)),
        }
        .with_disposition(DeliverySemantics::delivered_unverified())),
    }
}

fn was_ignored(error: &AdapterError) -> bool {
    error
        .details
        .as_ref()
        .and_then(|details| details["cause"].as_str())
        .is_some_and(|cause| {
            cause == Cause::ActivationNotGranted.as_str()
                || cause == Cause::ActivationRefused.as_str()
        })
}

/// Makes the window active through the window manager and returns only when
/// the display server and the window's own frame both say it is.
pub(in crate::system) fn run(
    world: &impl FocusWorld,
    win: &WindowInfo,
    deadline: Deadline,
) -> Result<(), AdapterError> {
    window_id::decode(&win.id).map_err(|error| {
        error.with_disposition(agent_desktop_core::DeliverySemantics::not_delivered())
    })?;
    check_process(world, win)?;
    if world.stopped(win.pid.get()) {
        return Err(AdapterError::app_unresponsive(&win.app));
    }
    match world.session() {
        Session::X11 => {}
        Session::Wayland => return Err(refusal(Cause::WaylandSession)),
        Session::NoDisplay => return Err(refusal(Cause::NoDisplay)),
    }
    let frame = world.frame()?;
    let (active, clients) = match world.clients() {
        X11State::Ready { active, clients } => (active, clients),
        X11State::NoWindowManager => return Err(refusal(Cause::NoWindowManager)),
        X11State::Unavailable => return Err(refusal(Cause::X11Unavailable)),
    };
    let client = client_of(world, win, &clients, || active).map_err(refusal)?;
    if world.overview_open() == Some(true) {
        return Err(refusal(Cause::OverviewOpen));
    }
    let view = client_view(world, client).map_err(refusal)?;
    let mut prior_delivery = DeliverySemantics::not_delivered();
    let outcome = (|| {
        if let Some(desktop) = view.other_desktop {
            prior_delivery = DeliverySemantics::uncertain();
            world
                .switch_desktop(desktop)
                .map_err(|_| refusal(Cause::ActivationNotSent))?;
            prior_delivery = DeliverySemantics::delivered_unverified();
        }
        let active = match (frame.minimized == Some(true))
            .then_some(Cause::WindowMinimized)
            .or_else(|| view.hidden.then_some(Cause::WindowHidden))
        {
            Some(cause) => {
                let lifted = world.lift(client)?;
                prior_delivery = DeliverySemantics::delivered_unverified();
                if let Lifted::StillHidden { manager } = lifted {
                    return Err(lift_refusal(cause, &manager));
                }
                if is_active(world, client).1 {
                    return Ok(());
                }
                world.active()
            }
            None if view.other_desktop.is_none()
                && active == Some(client)
                && (frame.active == Some(true)
                    || world.app_frame_active()
                    || world.menu_open()) =>
            {
                return Ok(());
            }
            None => active,
        };
        match ask_and_wait(world, client, active, deadline, false) {
            Err(error) if was_ignored(&error) => {
                if deadline.is_expired() {
                    return Err(AdapterError::timeout(
                    "The lease ran out before the window manager answered the activation request",
                )
                .with_disposition(DeliverySemantics::delivered_unverified()));
                }
                ask_and_wait(world, client, world.active(), deadline, true).map_err(|error| {
                    error.with_disposition(DeliverySemantics::delivered_unverified())
                })
            }
            outcome => outcome,
        }
    })();
    outcome.map_err(|error| {
        if prior_delivery == DeliverySemantics::not_delivered() {
            error
        } else {
            error.with_disposition(prior_delivery)
        }
    })
}

pub(crate) fn focus_window(
    bus: &SharedBus,
    win: &WindowInfo,
    lease: &InteractionLease,
) -> Result<(), AdapterError> {
    if shell::is_shell_window(win) {
        return Ok(());
    }
    let deadline = lease.deadline();
    crate::system::display::display_server::require(deadline)
        .map_err(|error| error.with_disposition(DeliverySemantics::not_delivered()))?;
    let world = focus_world::LiveWorld::new(bus, win, deadline)?;
    run(&world, win, deadline)
}

#[cfg(test)]
#[path = "focus_world_fake.rs"]
mod fake;

#[cfg(test)]
#[path = "focus_window_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "focus_fallback_tests.rs"]
mod fallback_tests;

#[cfg(test)]
#[path = "focus_lift_tests.rs"]
mod lift_tests;

#[cfg(test)]
#[path = "focus_lift_live_tests.rs"]
pub(in crate::system) mod lift_live_tests;

#[cfg(test)]
#[path = "focus_fallback_live_tests.rs"]
mod fallback_live_tests;
