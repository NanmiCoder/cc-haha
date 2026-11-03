use x11rb::connection::{Connection, RequestConnection};
use x11rb::protocol::Event;
use x11rb::protocol::xproto::{
    AtomEnum, ChangeWindowAttributesAux, ConnectionExt, CreateWindowAux, EventMask, PropMode,
    Property, SELECTION_NOTIFY_EVENT, SelectionNotifyEvent, WindowClass,
};
use x11rb::rust_connection::RustConnection;
use x11rb::wrapper::ConnectionExt as _;

use super::owner_request::{Answerer, Atoms, Chunk, Reply, Request, Served};
use super::owner_serve::{Lost, OwnerEvent, Wire};
use crate::input::clipboard::payload::Payload;

const REQUEST_HEADROOM_BYTES: usize = 1024;
const SINGLE_PROPERTY_LIMIT_BYTES: usize = 262_140;
const INCR_CHUNK_BYTES: usize = 1024 * 1024;

/// One claimed selection: the connection and window that own it, and the
/// pure answerer built from what the owner serves.
pub(crate) struct Claimed {
    pub(crate) wire: X11Wire,
    pub(crate) answerer: Answerer,
    pub(crate) window: u32,
    pub(crate) chunk_bytes: usize,
}

pub(crate) struct X11Wire {
    connection: RustConnection,
    window: u32,
    incr: u32,
}

fn failure(context: &str, error: impl std::fmt::Display) -> String {
    format!("{context}: {error}")
}

fn atom(connection: &RustConnection, name: &str) -> Result<u32, String> {
    connection
        .intern_atom(false, name.as_bytes())
        .map_err(|error| failure("intern_atom", error))?
        .reply()
        .map(|reply| reply.atom)
        .map_err(|error| failure("intern_atom", error))
}

fn server_time(connection: &RustConnection, window: u32, property: u32) -> Result<u32, String> {
    connection
        .change_property8(PropMode::APPEND, window, property, AtomEnum::STRING, &[])
        .map_err(|error| failure("timestamp request", error))?;
    connection
        .flush()
        .map_err(|error| failure("flush", error))?;
    loop {
        let event = connection
            .wait_for_event()
            .map_err(|error| failure("timestamp wait", error))?;
        if let Event::PropertyNotify(notify) = event {
            if notify.window == window && notify.atom == property {
                return Ok(notify.time);
            }
        }
    }
}

/// Connects, creates the owner window and takes the `CLIPBOARD` selection
/// with a server timestamp, then confirms the server names this window.
pub(crate) fn claim(display: &str, payload: &Payload) -> Result<Claimed, String> {
    let (connection, screen) =
        RustConnection::connect(Some(display)).map_err(|error| failure("connect", error))?;
    let root = connection
        .setup()
        .roots
        .get(screen)
        .map(|screen| screen.root)
        .ok_or("the X screen is missing")?;
    let window = connection
        .generate_id()
        .map_err(|error| failure("generate_id", error))?;
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
        .map_err(|error| failure("create_window", error))?;
    let atoms = Atoms {
        clipboard: atom(&connection, "CLIPBOARD")?,
        targets: atom(&connection, "TARGETS")?,
        timestamp: atom(&connection, "TIMESTAMP")?,
        incr: atom(&connection, "INCR")?,
    };
    let mut served = Vec::with_capacity(payload.targets.len());
    for target in &payload.targets {
        served.push(Served {
            atom: atom(&connection, &target.name)?,
            bytes: target.bytes.clone().into(),
        });
    }
    let claim_time = server_time(&connection, window, atoms.timestamp)?;
    connection
        .set_selection_owner(window, atoms.clipboard, claim_time)
        .map_err(|error| failure("set_selection_owner", error))?;
    let holder = connection
        .get_selection_owner(atoms.clipboard)
        .map_err(|error| failure("get_selection_owner", error))?
        .reply()
        .map_err(|error| failure("get_selection_owner", error))?
        .owner;
    if holder != window {
        return Err("another client took the selection during the claim".to_owned());
    }
    let request_bytes = connection
        .maximum_request_bytes()
        .saturating_sub(REQUEST_HEADROOM_BYTES);
    let incr_threshold = request_bytes.min(SINGLE_PROPERTY_LIMIT_BYTES - REQUEST_HEADROOM_BYTES);
    Ok(Claimed {
        wire: X11Wire {
            connection,
            window,
            incr: atoms.incr,
        },
        answerer: Answerer {
            atoms,
            served,
            claim_time,
            incr_threshold,
        },
        window,
        chunk_bytes: INCR_CHUNK_BYTES.min(request_bytes.max(1)),
    })
}

impl X11Wire {
    fn notify(&self, request: &Request, property: u32) {
        let event = SelectionNotifyEvent {
            response_type: SELECTION_NOTIFY_EVENT,
            sequence: 0,
            time: request.time,
            requestor: request.requestor,
            selection: request.selection,
            target: request.target,
            property,
        };
        let _ = self
            .connection
            .send_event(false, request.requestor, EventMask::NO_EVENT, event);
        let _ = self.connection.flush();
    }

    fn write_bytes(&self, window: u32, property: u32, kind: u32, data: &[u8]) {
        let _ = self
            .connection
            .change_property8(PropMode::REPLACE, window, property, kind, data);
    }
}

impl Wire for X11Wire {
    fn next_event(&mut self) -> Result<OwnerEvent, Lost> {
        let event = self.connection.wait_for_event().map_err(|_| Lost)?;
        Ok(match event {
            Event::SelectionRequest(request) => OwnerEvent::Request(Request {
                requestor: request.requestor,
                selection: request.selection,
                target: request.target,
                property: request.property,
                time: request.time,
            }),
            Event::SelectionClear(_) => OwnerEvent::Cleared,
            Event::PropertyNotify(notify)
                if notify.state == Property::DELETE && notify.window != self.window =>
            {
                OwnerEvent::PropertyDeleted {
                    window: notify.window,
                    property: notify.atom,
                }
            }
            Event::DestroyNotify(destroyed) => OwnerEvent::WindowGone(destroyed.window),
            _ => OwnerEvent::Other,
        })
    }

    fn send_reply(&mut self, request: &Request, reply: &Reply) {
        let property = match reply {
            Reply::Refuse => 0,
            Reply::Atoms { property, atoms } => {
                let _ = self.connection.change_property32(
                    PropMode::REPLACE,
                    request.requestor,
                    *property,
                    AtomEnum::ATOM,
                    atoms,
                );
                *property
            }
            Reply::Integer { property, value } => {
                let _ = self.connection.change_property32(
                    PropMode::REPLACE,
                    request.requestor,
                    *property,
                    AtomEnum::INTEGER,
                    &[*value],
                );
                *property
            }
            Reply::Bytes {
                property,
                kind,
                data,
            } => {
                self.write_bytes(request.requestor, *property, *kind, data);
                *property
            }
            Reply::StartIncr {
                property, total, ..
            } => {
                let _ = self.connection.change_window_attributes(
                    request.requestor,
                    &ChangeWindowAttributesAux::new()
                        .event_mask(EventMask::PROPERTY_CHANGE | EventMask::STRUCTURE_NOTIFY),
                );
                let _ = self.connection.change_property32(
                    PropMode::REPLACE,
                    request.requestor,
                    *property,
                    self.incr,
                    &[*total],
                );
                *property
            }
        };
        self.notify(request, property);
    }

    fn send_chunk(&mut self, chunk: &Chunk) {
        self.write_bytes(chunk.requestor, chunk.property, chunk.kind, &chunk.data);
        let _ = self.connection.flush();
    }
}
