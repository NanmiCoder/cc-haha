use crate::system::window::window_op::window_op_verdict::POLL;
use std::cell::{Cell, RefCell};
use std::time::Duration;

use agent_desktop_core::AdapterError;

use super::world::World;
use crate::system::process::liveness::Liveness;
use crate::system::process::process_facts::ProcessFacts;
use crate::system::process::process_lookup::Lookup;
use crate::system::signal::Signal;
use crate::system::signal::signal_sent::Sent;
use crate::system::x11::control::ControlRead;
use crate::system::x11::control::control_error::ControlError;
use crate::system::x11::window::toplevel::Toplevel;
use crate::system::x11::window::window_kind::WindowKind;

pub(super) fn window(id: u32) -> Toplevel {
    Toplevel {
        id,
        title: String::new(),
        kind: WindowKind::Normal,
        transient: false,
    }
}

pub(super) fn dialog(id: u32) -> Toplevel {
    Toplevel {
        id,
        title: format!("dialog {id}"),
        kind: WindowKind::Dialog,
        transient: true,
    }
}

pub(super) fn facts(comm: &str) -> Lookup {
    Lookup::Found(ProcessFacts {
        executable: None,
        comm: comm.to_owned(),
        exe_basename: Some(comm.to_owned()),
        instance: "t".to_owned(),
    })
}

/// A process and a clock for the close flow. The process changes state only
/// as the fields below say, so each test names what the app does.
pub(super) struct Fake {
    pub(super) state: Cell<Liveness>,
    pub(super) clock: Cell<Duration>,
    pub(super) budget: Duration,
    pub(super) facts: Lookup,
    pub(super) protected: Result<bool, AdapterError>,
    pub(super) windows: ControlRead<Vec<Toplevel>>,
    pub(super) late: ControlRead<Vec<Toplevel>>,
    pub(super) closes: RefCell<Vec<Result<(), ControlError>>>,
    pub(super) exits_on_close: bool,
    pub(super) exits_on_failed_close: bool,
    pub(super) state_after_toplevels: Option<Liveness>,
    pub(super) exits_on_term: bool,
    pub(super) exits_on_kill: bool,
    pub(super) signal_outcomes: RefCell<Vec<Result<Sent, AdapterError>>>,
    pub(super) expire_after_closes: Option<usize>,
    pub(super) log: RefCell<Vec<String>>,
    pub(super) wayland: bool,
    pub(super) dialog_after: Option<Duration>,
    pub(super) second_dialog_after: Option<Duration>,
    pub(super) nested_after: Option<Duration>,
    pub(super) gone_after: Option<Duration>,
}

impl Fake {
    pub(super) fn new(state: Liveness) -> Self {
        Self {
            state: Cell::new(state),
            clock: Cell::new(Duration::ZERO),
            budget: Duration::from_secs(10),
            facts: facts("calculator"),
            protected: Ok(false),
            windows: ControlRead::Ready(vec![window(1)]),
            late: ControlRead::Ready(Vec::new()),
            closes: RefCell::new(Vec::new()),
            exits_on_close: false,
            exits_on_failed_close: false,
            state_after_toplevels: None,
            exits_on_term: false,
            exits_on_kill: false,
            signal_outcomes: RefCell::new(Vec::new()),
            expire_after_closes: None,
            log: RefCell::new(Vec::new()),
            wayland: false,
            dialog_after: None,
            second_dialog_after: None,
            nested_after: None,
            gone_after: None,
        }
    }

    pub(super) fn count(&self, entry: &str) -> usize {
        self.log.borrow().iter().filter(|e| *e == entry).count()
    }

    fn note(&self, entry: &str) {
        self.log.borrow_mut().push(entry.to_owned());
    }
}

impl World for Fake {
    fn is_protected(&self) -> Result<bool, AdapterError> {
        self.note("protected");
        self.protected.clone()
    }

    fn facts(&self) -> Lookup {
        self.note("facts");
        self.facts.clone()
    }

    fn liveness(&self) -> Liveness {
        self.note("liveness");
        if self
            .gone_after
            .is_some_and(|after| self.clock.get() >= after)
        {
            return Liveness::Gone;
        }
        self.state.get()
    }

    fn elapsed(&self) -> Duration {
        self.clock.get()
    }

    fn remaining(&self) -> Duration {
        let closes = self.count("close");
        if self
            .expire_after_closes
            .is_some_and(|limit| closes >= limit)
        {
            return Duration::ZERO;
        }
        self.budget.saturating_sub(self.clock.get())
    }

    fn pause(&self) {
        self.clock.set(self.clock.get() + POLL);
    }

    fn toplevels(&self) -> ControlRead<Vec<Toplevel>> {
        self.note("toplevels");
        if let Some(state) = self.state_after_toplevels {
            self.state.set(state);
        }
        let mut read = self.windows.clone();
        if let (ControlRead::Ready(windows), Some(after)) = (&mut read, self.dialog_after)
            && self.clock.get() >= after
        {
            windows.push(dialog(99));
        }
        if let (ControlRead::Ready(windows), Some(after)) = (&mut read, self.second_dialog_after)
            && self.clock.get() >= after
        {
            windows.push(dialog(98));
        }
        read
    }

    fn toplevels_late(&self) -> ControlRead<Vec<Toplevel>> {
        self.note("late");
        self.late.clone()
    }

    fn nested_dialogs(&self) -> Vec<String> {
        self.note("nested");
        match self.nested_after {
            Some(after) if self.clock.get() >= after => vec!["Save Changes?".to_owned()],
            _ => Vec::new(),
        }
    }

    fn request_close(&self, _window: u32) -> Result<(), ControlError> {
        self.note("close");
        let result = {
            let mut results = self.closes.borrow_mut();
            if results.is_empty() {
                Ok(())
            } else {
                results.remove(0)
            }
        };
        let exits = if result.is_ok() {
            self.exits_on_close
        } else {
            self.exits_on_failed_close
        };
        if exits {
            self.state.set(Liveness::Gone);
        }
        result
    }

    fn signal(&self, signal: Signal) -> Result<Sent, AdapterError> {
        self.note(match signal {
            Signal::Term => "term",
            Signal::Kill => "kill",
        });
        if !self.signal_outcomes.borrow().is_empty() {
            let outcome = self.signal_outcomes.borrow_mut().remove(0);
            return outcome;
        }
        let exits = match signal {
            Signal::Term => self.exits_on_term,
            Signal::Kill => self.exits_on_kill,
        };
        if exits {
            self.state.set(Liveness::Gone);
        }
        Ok(Sent::Delivered)
    }

    fn on_wayland(&self) -> bool {
        self.wayland
    }

    fn timeout_error(&self) -> AdapterError {
        AdapterError::timeout("Operation exceeded its deadline")
    }
}
