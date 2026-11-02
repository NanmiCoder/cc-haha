use std::sync::Arc;
use std::thread::sleep;
use std::time::Duration;

use agent_desktop_core::{Deadline, MAX_PNG_INPUT_BYTES};
use x11rb::connection::Connection;
use x11rb::protocol::Event;
use x11rb::protocol::xproto::{
    AtomEnum, ConnectionExt, CreateWindowAux, EventMask, Property, WindowClass,
};
use x11rb::rust_connection::RustConnection;
use x11rb::{CURRENT_TIME, NONE};

use super::release_gate::ReleaseGate;
use super::x11_read::{Converted, Fault, Requestor};
use crate::system::x11::{self, fault_of_connect};

const POLL_PAUSE: Duration = Duration::from_millis(1);
const PROPERTY_NAME: &str = "AGENT_DESKTOP_CLIPBOARD";
const WORDS_PER_PROPERTY_READ: u32 = (MAX_PNG_INPUT_BYTES / 4 + 1024) as u32;

pub(crate) struct X11Requestor {
    connection: RustConnection,
    window: u32,
    clipboard: u32,
    property: u32,
    owner: u32,
}

fn protocol(error: impl std::fmt::Display) -> Fault {
    Fault::Protocol(error.to_string())
}

fn atom(connection: &RustConnection, name: &str) -> Result<u32, Fault> {
    connection
        .intern_atom(false, name.as_bytes())
        .map_err(protocol)?
        .reply()
        .map(|reply| reply.atom)
        .map_err(protocol)
}

impl X11Requestor {
    pub(crate) fn connect(display: &str) -> Result<Self, Fault> {
        let (connection, screen) = x11::DisplayReader::connect(display)
            .map_err(|error| Fault::Connect(fault_of_connect(&error)))?;
        let root = connection
            .setup()
            .roots
            .get(screen)
            .map(|screen| screen.root)
            .ok_or_else(|| Fault::Protocol("The X screen is missing".into()))?;
        let window = connection.generate_id().map_err(protocol)?;
        connection
            .create_window(
                0,
                window,
                root,
                0,
                0,
                1,
                1,
                0,
                WindowClass::INPUT_ONLY,
                0,
                &CreateWindowAux::new().event_mask(EventMask::PROPERTY_CHANGE),
            )
            .map_err(protocol)?;
        let clipboard = atom(&connection, "CLIPBOARD")?;
        let property = atom(&connection, PROPERTY_NAME)?;
        let owner = connection
            .get_selection_owner(clipboard)
            .map_err(protocol)?
            .reply()
            .map_err(protocol)?
            .owner;
        Ok(Self {
            connection,
            window,
            clipboard,
            property,
            owner,
        })
    }

    pub(crate) fn owner_window(&self) -> Option<u32> {
        (self.owner != NONE).then_some(self.owner)
    }

    fn wait_for(
        &self,
        deadline: Deadline,
        matches: impl Fn(&Event) -> bool,
    ) -> Result<Event, Fault> {
        loop {
            match self.connection.poll_for_event().map_err(protocol)? {
                Some(event) if matches(&event) => return Ok(event),
                Some(_) => {}
                None if deadline.is_expired() => return Err(Fault::Timeout),
                None => sleep(POLL_PAUSE.min(deadline.remaining())),
            }
        }
    }

    fn read_property(&self) -> Result<(u32, Vec<u8>), Fault> {
        let reply = self
            .connection
            .get_property(
                true,
                self.window,
                self.property,
                AtomEnum::ANY,
                0,
                WORDS_PER_PROPERTY_READ,
            )
            .map_err(protocol)?
            .reply()
            .map_err(protocol)?;
        if reply.bytes_after != 0 {
            return Err(Fault::OverCap);
        }
        Ok((reply.type_, reply.value))
    }

    fn convert(&self, target: u32, deadline: Deadline) -> Result<bool, Fault> {
        self.connection
            .convert_selection(
                self.window,
                self.clipboard,
                target,
                self.property,
                CURRENT_TIME,
            )
            .map_err(protocol)?;
        self.connection.flush().map_err(protocol)?;
        let window = self.window;
        let event = self.wait_for(
            deadline,
            |event| matches!(event, Event::SelectionNotify(notify) if notify.requestor == window),
        )?;
        Ok(matches!(event, Event::SelectionNotify(notify) if notify.property != NONE))
    }
}

fn atoms_of(bytes: &[u8]) -> Vec<u32> {
    bytes
        .chunks_exact(4)
        .map(|word| u32::from_ne_bytes([word[0], word[1], word[2], word[3]]))
        .collect()
}

impl Requestor for X11Requestor {
    fn offered(&mut self, deadline: Deadline) -> Result<Option<Vec<String>>, Fault> {
        if self.owner_window().is_none() {
            return Ok(None);
        }
        let targets = atom(&self.connection, "TARGETS")?;
        if !self.convert(targets, deadline)? {
            return Ok(None);
        }
        let (_, bytes) = self.read_property()?;
        let mut names = Vec::new();
        for id in atoms_of(&bytes) {
            let reply = self
                .connection
                .get_atom_name(id)
                .map_err(protocol)?
                .reply()
                .map_err(protocol)?;
            names.push(String::from_utf8_lossy(&reply.name).into_owned());
        }
        Ok(Some(names))
    }

    fn request(&mut self, target: &str, deadline: Deadline) -> Result<Converted, Fault> {
        let wanted = atom(&self.connection, target)?;
        if !self.convert(wanted, deadline)? {
            return Ok(Converted::Refused);
        }
        let incr = atom(&self.connection, "INCR")?;
        let (kind, bytes) = self.read_property()?;
        if kind == incr {
            Ok(Converted::Incr)
        } else {
            Ok(Converted::Value(bytes))
        }
    }

    fn next_chunk(&mut self, deadline: Deadline) -> Result<Vec<u8>, Fault> {
        let (window, property) = (self.window, self.property);
        self.wait_for(deadline, |event| {
            matches!(event, Event::PropertyNotify(notify)
                if notify.window == window
                    && notify.atom == property
                    && notify.state == Property::NEW_VALUE)
        })?;
        let (_, bytes) = self.read_property()?;
        Ok(bytes)
    }

    fn owner_pid(&mut self) -> Option<u32> {
        let owner = self.owner_window()?;
        let pid_atom = atom(&self.connection, "_NET_WM_PID").ok()?;
        let reply = self
            .connection
            .get_property(false, owner, pid_atom, AtomEnum::CARDINAL, 0, 1)
            .ok()?
            .reply()
            .ok()?;
        reply.value32()?.next()
    }
}

pub(crate) trait SelectionServer {
    fn owner(&self, display: &str, deadline: Deadline) -> Result<Option<u32>, Fault>;
    fn targets(&self, display: &str, deadline: Deadline) -> Result<Vec<String>, Fault>;
    fn release(&self, display: &str, deadline: Deadline) -> Result<(), Fault>;
}

pub(crate) struct X11Server;

fn bounded<T: Send + 'static>(
    deadline: Deadline,
    work: impl FnOnce() -> Result<T, Fault> + Send + 'static,
) -> Result<T, Fault> {
    x11::start(work)
        .finish(deadline)
        .unwrap_or(Err(Fault::Timeout))
}

impl SelectionServer for X11Server {
    fn owner(&self, display: &str, deadline: Deadline) -> Result<Option<u32>, Fault> {
        let display = display.to_owned();
        bounded(deadline, move || {
            Ok(X11Requestor::connect(&display)?.owner_window())
        })
    }

    fn targets(&self, display: &str, deadline: Deadline) -> Result<Vec<String>, Fault> {
        let display = display.to_owned();
        bounded(deadline, move || {
            let mut requestor = X11Requestor::connect(&display)?;
            Ok(requestor.offered(deadline)?.unwrap_or_default())
        })
    }

    fn release(&self, display: &str, deadline: Deadline) -> Result<(), Fault> {
        let display = display.to_owned();
        let gate = Arc::new(ReleaseGate::default());
        let worker = Arc::clone(&gate);
        let outcome = bounded(deadline, move || {
            let requestor = X11Requestor::connect(&display)?;
            if !worker.commit() {
                return Err(Fault::Timeout);
            }
            requestor
                .connection
                .set_selection_owner(NONE, requestor.clipboard, CURRENT_TIME)
                .map_err(protocol)?;
            requestor
                .connection
                .get_input_focus()
                .map_err(protocol)?
                .reply()
                .map_err(protocol)?;
            Ok(())
        });
        gate.settle(outcome)
    }
}
