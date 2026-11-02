use std::time::{Duration, Instant};

use agent_desktop_core::{AdapterError, Deadline};

use crate::system::display::display_server::{DisplayServer, session_server};
use crate::system::menu::surfaces;
use crate::system::process::liveness::{self, Liveness};
use crate::system::process::process_lookup::Lookup;
use crate::system::signal::Signal;
use crate::system::signal::signal_sent::Sent;
use crate::system::window::window_op::window_op_verdict::POLL;
use crate::system::x11::control;
use crate::system::x11::control::ControlRead;
use crate::system::x11::control::control_error::ControlError;
use crate::system::x11::window::toplevel::Toplevel;
use crate::system::{
    process::{process_facts, protected},
    signal,
};

const LATE_READ_MS: u64 = 300;
const NESTED_LOOK_MS: u64 = 300;

/// What the close flow touches outside itself. The live implementation reads
/// `/proc`, talks to the display server and signals through a descriptor; a
/// test supplies a process and a clock of its own.
pub(super) trait World {
    fn is_protected(&self) -> Result<bool, AdapterError>;
    fn facts(&self) -> Lookup;
    fn liveness(&self) -> Liveness;
    fn elapsed(&self) -> Duration;
    fn remaining(&self) -> Duration;
    fn pause(&self);
    fn toplevels(&self) -> ControlRead<Vec<Toplevel>>;
    fn toplevels_late(&self) -> ControlRead<Vec<Toplevel>>;
    fn nested_dialogs(&self) -> Vec<String>;
    fn request_close(&self, window: u32) -> Result<(), ControlError>;
    fn signal(&self, signal: Signal) -> Result<Sent, AdapterError>;
    fn timeout_error(&self) -> AdapterError;
    fn on_wayland(&self) -> bool;
}

pub(super) struct Live<'a> {
    pub(super) bus: &'a crate::system::SharedBus,
    pub(super) pid: u32,
    pub(super) instance: &'a str,
    pub(super) deadline: Deadline,
    pub(super) started: Instant,
}

impl World for Live<'_> {
    fn is_protected(&self) -> Result<bool, AdapterError> {
        protected::is_protected(self.bus, self.pid, self.instance, self.deadline)
    }

    fn facts(&self) -> Lookup {
        process_facts::lookup(self.pid)
    }

    fn liveness(&self) -> Liveness {
        liveness::liveness(self.pid, self.instance)
    }

    fn elapsed(&self) -> Duration {
        self.started.elapsed()
    }

    fn remaining(&self) -> Duration {
        self.deadline.remaining()
    }

    fn pause(&self) {
        std::thread::sleep(self.deadline.remaining().min(POLL));
    }

    fn toplevels(&self) -> ControlRead<Vec<Toplevel>> {
        control::toplevels_of(self.pid, self.deadline)
    }

    fn toplevels_late(&self) -> ControlRead<Vec<Toplevel>> {
        match Deadline::detached_after(LATE_READ_MS) {
            Ok(deadline) => control::toplevels_of(self.pid, deadline),
            Err(_) => ControlRead::Unavailable,
        }
    }

    fn nested_dialogs(&self) -> Vec<String> {
        let look = self.deadline.capped(Duration::from_millis(NESTED_LOOK_MS));
        surfaces::nested_dialog_titles(self.bus, self.pid, look).unwrap_or_default()
    }

    fn request_close(&self, window: u32) -> Result<(), ControlError> {
        control::request_close(window, self.pid, self.instance, self.deadline)
    }

    fn signal(&self, signal: Signal) -> Result<Sent, AdapterError> {
        signal::send(self.pid, self.instance, signal)
    }

    fn timeout_error(&self) -> AdapterError {
        self.deadline.timeout_error()
    }

    fn on_wayland(&self) -> bool {
        matches!(session_server(), DisplayServer::Wayland)
    }
}
