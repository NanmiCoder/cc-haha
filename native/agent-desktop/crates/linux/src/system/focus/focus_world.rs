use std::{cell::RefCell, time::Duration};

use agent_desktop_core::{AdapterError, Deadline, SignalFilter, WaitWakeup, WindowInfo};

use super::focus_window::{FocusWorld, Session};
use crate::system::bus::bus_deadline::within;
use crate::system::display::display_server::{DisplayServer, session_server};
use crate::system::focus::focus_frame_view::FrameView;
use crate::system::focus::restore_minimized::{self, Lifted};
use crate::system::menu::menu_focus;
use crate::system::menu::overview::overview_open;
use crate::system::process::process_lookup::Lookup;
use crate::system::process::{proc_stat, process_facts};
use crate::system::registry::toolkit;
use crate::system::window::window_client::ClientWorld;
use crate::system::window::window_filter::frame_state;
use crate::system::x11::control::activate::active_window_within;
use crate::system::x11::control::activate_error::ActivateError;
use crate::system::x11::control::control_error::ControlError;
use crate::system::x11::control::control_send::activate_window;
use crate::system::x11::stacking::stacking_read::StackingRead;
use crate::system::x11::stacking::stacking_source::StackingSource;
use crate::system::x11::twin_tie::Twins;
use crate::system::x11::{DisplayReader, X11State};
use crate::system::{SharedBus, window::window_id};
use crate::tree::properties::toolkit_trust::reports_global_position;
use crate::tree::surfaces::top_level::is_dialog_role;
use crate::tree::surfaces::twin_frames::read_twins;
use crate::tree::vocabulary::state_bits::{ACTIVE, StateBits};
use crate::tree::{AtspiElement, list_children, read_node};

#[path = "focus_send.rs"]
pub(in crate::system) mod focus_send;

const ROOT_PATH: &str = "/org/a11y/atspi/accessible/root";
const ACTIVE_READ: Duration = Duration::from_millis(500);
const WAKE_POLL: Duration = Duration::from_millis(100);

/// The live desktop `focus_window` reads and writes: the accessibility bus
/// for the frame and the display server for the window manager.
pub(in crate::system) struct LiveWorld<'a> {
    bus: &'a SharedBus,
    frame: AtspiElement,
    owner: agent_desktop_core::ProcessIdentity,
    deadline: Deadline,
    wake: RefCell<Option<crate::system::signal::subscription::Subscription>>,
}

impl<'a> LiveWorld<'a> {
    pub(in crate::system) fn new(
        bus: &'a SharedBus,
        win: &WindowInfo,
        deadline: Deadline,
    ) -> Result<Self, AdapterError> {
        let (bus_name, path) = window_id::decode(&win.id)?;
        Ok(Self {
            bus,
            frame: AtspiElement::new(bus_name, path, win.pid.get()),
            owner: agent_desktop_core::ProcessIdentity::new(
                win.pid,
                win.process_instance.clone().unwrap_or_default(),
            ),
            deadline,
            wake: RefCell::new(None),
        })
    }
}

impl FocusWorld for LiveWorld<'_> {
    fn arm_wake(&self) {
        if self.wake.borrow().is_some() {
            return;
        }
        let filter = SignalFilter {
            process: Some(self.owner.clone()),
            ..Default::default()
        };
        *self.wake.borrow_mut() = crate::system::signal::subscription::Subscription::open(
            self.bus,
            &filter,
            self.deadline,
        )
        .ok();
    }

    fn wait_for_change(&self, deadline: Deadline) {
        let deadline = deadline.capped(WAKE_POLL);
        let mut wake = self.wake.borrow_mut();
        if let Some(subscription) = wake.as_mut() {
            if subscription.wait(deadline).is_ok() {
                return;
            }
            *wake = None;
        }
        std::thread::sleep(deadline.remaining());
    }

    fn session(&self) -> Session {
        match session_server() {
            DisplayServer::X11(_) => Session::X11,
            DisplayServer::Wayland => Session::Wayland,
            DisplayServer::Unavailable(..) => Session::NoDisplay,
        }
    }

    fn lookup(&self, pid: u32) -> Lookup {
        process_facts::lookup(pid)
    }

    fn frame(&self) -> Result<FrameView, AdapterError> {
        let shared = self.bus.get(self.deadline)?;
        let node = within(self.deadline, async {
            read_node(shared.inner(), &self.frame).await
        })?;
        let state = frame_state(&node.traits.states);
        Ok(FrameView {
            minimized: state.minimized,
            active: state.active,
            modal: state.modal,
            dialog: is_dialog_role(node.traits.role.present()),
        })
    }

    fn clients(&self) -> X11State {
        DisplayReader.clients_within(self.deadline)
    }

    fn stacking(&self, client: u32) -> StackingRead {
        DisplayReader.read_within(client, self.deadline)
    }

    fn send(&self, client: u32) -> Result<(), ControlError> {
        activate_window(client, &self.owner, self.deadline, true)
    }

    fn active(&self) -> Option<u32> {
        active_window_within(ACTIVE_READ)
    }

    fn stopped(&self, pid: u32) -> bool {
        proc_stat::is_stopped(pid)
    }

    fn send_untimed(&self, client: u32) -> Result<(), ControlError> {
        activate_window(client, &self.owner, self.deadline, false)
    }

    fn switch_desktop(&self, desktop: u32) -> Result<(), ActivateError> {
        focus_send::switch_desktop(desktop, self.deadline)
    }

    fn input_focus_in(&self, client: u32) -> bool {
        focus_send::input_focus_in(client, self.deadline)
    }

    fn menu_open(&self) -> bool {
        menu_focus::open_at(self.bus, &self.frame, self.deadline).unwrap_or(false)
    }

    fn app_frame_active(&self) -> bool {
        let Ok(shared) = self.bus.get(self.deadline) else {
            return false;
        };
        within(self.deadline, async {
            let roots = AtspiElement::new(
                crate::system::REGISTRY_SERVICE,
                crate::system::REGISTRY_ROOT_PATH,
                self.frame.pid(),
            );
            let apps = list_children(shared.inner(), &roots).await?;
            for (bus_name, path) in apps {
                if bus_name != self.frame.bus_name() {
                    continue;
                }
                let app = AtspiElement::new(bus_name.clone(), path, self.frame.pid());
                let Ok(frames) = list_children(shared.inner(), &app).await else {
                    continue;
                };
                for (frame_bus, frame_path) in frames {
                    let frame = AtspiElement::new(frame_bus, frame_path, self.frame.pid());
                    let Ok(node) = read_node(shared.inner(), &frame).await else {
                        continue;
                    };
                    let Some(states) = node.traits.states.present() else {
                        continue;
                    };
                    if StateBits::new(states).has(ACTIVE) {
                        return Ok(true);
                    }
                }
            }
            Ok(false)
        })
        .unwrap_or(false)
    }

    fn overview_open(&self) -> Option<bool> {
        overview_open()
    }

    fn modal_over(&self, client: u32) -> Option<String> {
        focus_send::dialog_over(client, self.deadline)
    }

    fn lift(&self, client: u32) -> Result<Lifted, AdapterError> {
        restore_minimized::lift(client, &self.owner, self.deadline)
    }
}

impl ClientWorld for LiveWorld<'_> {
    fn twins(&self, win: &WindowInfo) -> Option<Twins> {
        let shared = self.bus.get(self.deadline).ok()?;
        within(self.deadline, async {
            Ok(read_twins(shared.inner(), &self.frame, &win.title).await)
        })
        .ok()
        .flatten()
    }

    fn global_position(&self) -> bool {
        let Ok(shared) = self.bus.get(self.deadline) else {
            return false;
        };
        let root = AtspiElement::new(self.frame.bus_name(), ROOT_PATH, self.frame.pid());
        let read = within(self.deadline, async {
            Ok(toolkit(shared.inner(), &root).await)
        });
        read.is_ok_and(|id| reports_global_position(&id))
    }
}
