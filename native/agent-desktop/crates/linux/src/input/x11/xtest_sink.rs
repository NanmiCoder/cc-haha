use agent_desktop_core::{AdapterError, Deadline, ErrorCode};
use std::os::fd::AsFd;
use std::time::{Duration, Instant};
use x11rb::connection::{Connection, RequestConnection};
use x11rb::protocol::Event;
use x11rb::protocol::xkb::{ConnectionExt as _, ID};
use x11rb::protocol::xproto::{ConnectionExt as _, Window};
use x11rb::protocol::xtest::{self, ConnectionExt as _};
use x11rb::rust_connection::RustConnection;

use super::io_cutoff::IoCutoff;

use super::pointer_read::PointerRead;

use super::sink_error::SinkError;

use super::sink::X11Sink;
use crate::input::keyboard::keymap::Keymap;
use crate::input::keyboard::keymap_edit::KeymapEdit;

const KEY_PRESS: u8 = 2;
const KEY_RELEASE: u8 = 3;
const BUTTON_PRESS: u8 = 4;
const BUTTON_RELEASE: u8 = 5;
const MOTION_NOTIFY: u8 = 6;
const ABSOLUTE_MOTION: u8 = 0;
const NO_DEVICE: u8 = 0;
const IMMEDIATELY: u32 = 0;

pub(crate) struct XtestSink {
    connection: RustConnection,
    root: Window,
    min_keycode: u8,
    max_keycode: u8,
    xkb_ready: bool,
    _cutoff: IoCutoff,
}

fn request(error: impl std::fmt::Display) -> SinkError {
    SinkError::Request(error.to_string())
}

fn no_xtest() -> AdapterError {
    AdapterError::new(
        ErrorCode::ActionNotSupported,
        "The display server has no XTEST extension, so input cannot be synthesised",
    )
    .with_suggestion("Use the semantic action instead of the --headed route")
    .with_details(serde_json::json!({ "physical_delivery_started": false }))
    .with_disposition(agent_desktop_core::DeliverySemantics::not_delivered())
}

fn unreachable_display(display: &str, error: impl std::fmt::Display) -> AdapterError {
    let mut error = crate::system::display::display_server::display_cause_error(
        &crate::system::display::display_server::DisplayCause::Refused {
            detail: format!("{display}: {error}"),
        },
    );
    error.details.get_or_insert_with(|| serde_json::json!({}))["physical_delivery_started"] =
        false.into();
    error.with_disposition(agent_desktop_core::DeliverySemantics::not_delivered())
}

fn open_connection(
    display: &str,
    cutoff_after: Duration,
) -> Result<(RustConnection, usize, IoCutoff), AdapterError> {
    let started = Instant::now();
    let (connection, screen) =
        crate::system::x11::DisplayReader::connect(display).map_err(|error| {
            crate::system::display::display_server::fault_error(
                display,
                Some(crate::system::x11::fault_of_connect(&error)),
            )
        })?;
    let cutoff = IoCutoff::arm(
        connection.stream().as_fd(),
        cutoff_after.saturating_sub(started.elapsed()),
    )
    .map_err(|error| {
        AdapterError::internal(format!("The display cutoff could not be armed: {error}"))
    })?;
    Ok((connection, screen, cutoff))
}

impl XtestSink {
    pub(crate) fn connect(
        display: &str,
        deadline: Deadline,
        cutoff_after: Duration,
    ) -> Result<Self, AdapterError> {
        let name = display.to_owned();
        let pending = crate::system::x11::start(move || Self::open(&name, cutoff_after));
        pending.finish(deadline).unwrap_or_else(|| {
            Err(crate::system::display::display_server::display_cause_error(
                &crate::system::display::display_server::DisplayCause::Silent,
            )
            .with_disposition(agent_desktop_core::DeliverySemantics::not_delivered()))
        })
    }

    fn open(display: &str, cutoff_after: Duration) -> Result<Self, AdapterError> {
        let (connection, screen, cutoff) = open_connection(display, cutoff_after).map_err(|mut error| {
            error.details.get_or_insert_with(|| serde_json::json!({}))["physical_delivery_started"] = false.into();
            error.with_disposition(agent_desktop_core::DeliverySemantics::not_delivered())
        })?;
        let has_xtest = connection
            .extension_information(xtest::X11_EXTENSION_NAME)
            .map_err(|error| unreachable_display(display, error))?
            .is_some();
        if !has_xtest {
            return Err(no_xtest());
        }
        let setup = connection.setup();
        let root = setup
            .roots
            .get(screen)
            .ok_or_else(|| unreachable_display(display, "no screen"))?
            .root;
        let (min_keycode, max_keycode) = (setup.min_keycode, setup.max_keycode);
        Ok(Self {
            connection,
            root,
            min_keycode,
            max_keycode,
            xkb_ready: false,
            _cutoff: cutoff,
        })
    }

    fn fake(&self, kind: u8, detail: u8, x: i16, y: i16) -> Result<(), SinkError> {
        self.connection
            .xtest_fake_input(kind, detail, IMMEDIATELY, self.root, x, y, NO_DEVICE)
            .map_err(request)?;
        self.connection.flush().map_err(|_| SinkError::Closed)
    }

    fn text_state(&mut self) -> Result<Keymap, SinkError> {
        if !self.xkb_ready {
            let reply = self
                .connection
                .xkb_use_extension(1, 0)
                .map_err(request)?
                .reply()
                .map_err(request)?;
            if !reply.supported {
                return Err(SinkError::Request(
                    "The display server has no compatible XKB extension".into(),
                ));
            }
            self.xkb_ready = true;
        }
        let state = self
            .connection
            .xkb_get_state(ID::USE_CORE_KBD.into())
            .map_err(request)?
            .reply()
            .map_err(request)?;
        Ok(Keymap {
            group: state.group.into(),
            modifiers: state.mods.into(),
            ..Keymap::default()
        })
    }
}

impl X11Sink for XtestSink {
    fn key(&mut self, code: u8, down: bool) -> Result<(), SinkError> {
        self.fake(if down { KEY_PRESS } else { KEY_RELEASE }, code, 0, 0)
    }

    fn button(&mut self, code: u8, down: bool) -> Result<(), SinkError> {
        self.fake(if down { BUTTON_PRESS } else { BUTTON_RELEASE }, code, 0, 0)
    }

    fn move_to(&mut self, x: i16, y: i16) -> Result<(), SinkError> {
        self.fake(MOTION_NOTIFY, ABSOLUTE_MOTION, x, y)
    }

    fn round_trip(&mut self) -> Result<(), SinkError> {
        self.connection
            .get_input_focus()
            .map_err(request)?
            .reply()
            .map_err(request)?;
        while let Some(event) = self.connection.poll_for_event().map_err(request)? {
            if let Event::Error(error) = event {
                return Err(request(format!("{error:?}")));
            }
        }
        Ok(())
    }

    fn pointer(&mut self) -> Result<PointerRead, SinkError> {
        let reply = self
            .connection
            .query_pointer(self.root)
            .map_err(request)?
            .reply()
            .map_err(request)?;
        Ok(PointerRead {
            x: i32::from(reply.root_x),
            y: i32::from(reply.root_y),
            mask: u16::from(reply.mask),
        })
    }

    fn keys_down(&mut self) -> Result<[u8; 32], SinkError> {
        let reply = self
            .connection
            .query_keymap()
            .map_err(request)?
            .reply()
            .map_err(request)?;
        <[u8; 32]>::try_from(reply.keys.as_slice()).map_err(request)
    }

    fn keymap(&mut self) -> Result<Keymap, SinkError> {
        let count = self.max_keycode - self.min_keycode + 1;
        let keys = self
            .connection
            .get_keyboard_mapping(self.min_keycode, count)
            .map_err(request)?
            .reply()
            .map_err(request)?;
        let modifiers = self
            .connection
            .get_modifier_mapping()
            .map_err(request)?
            .reply()
            .map_err(request)?;
        let state = self.text_state()?;
        let mut map = Keymap::new(
            self.min_keycode,
            keys.keysyms_per_keycode,
            keys.keysyms,
            u8::try_from(modifiers.keycodes.len() / 8).map_err(request)?,
            modifiers.keycodes,
        );
        map.group = state.group;
        map.modifiers = state.modifiers;
        Ok(map)
    }

    fn ensure_text_state(&mut self) -> Result<(), AdapterError> {
        self.keymap()
            .map_err(SinkError::into_adapter)?
            .ensure_text_state()
    }

    fn edit_keymap(&mut self, edit: &KeymapEdit) -> Result<(), SinkError> {
        let width = u8::try_from(edit.keysyms.len()).map_err(request)?;
        self.connection
            .change_keyboard_mapping(1, edit.keycode, width, &edit.keysyms)
            .map_err(request)?;
        self.connection.flush().map_err(|_| SinkError::Closed)
    }

    fn root_size(&mut self) -> Result<(u16, u16), SinkError> {
        let reply = self
            .connection
            .get_geometry(self.root)
            .map_err(request)?
            .reply()
            .map_err(request)?;
        Ok((reply.width, reply.height))
    }
}

#[cfg(test)]
#[path = "xtest_sink_tests.rs"]
mod tests;
