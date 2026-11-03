use std::os::fd::AsFd;

use agent_desktop_core::Deadline;
use x11rb::connection::Connection;
use x11rb::protocol::xproto::ConnectionExt;
use x11rb::rust_connection::RustConnection;

use crate::input::x11::io_cutoff::IoCutoff;
use crate::system::x11::control::control_error::ControlError;

pub(in crate::system::x11) struct ServerGrab<'a> {
    connection: &'a RustConnection,
    _cutoff: IoCutoff,
}

impl<'a> ServerGrab<'a> {
    pub(in crate::system::x11) fn acquire(
        connection: &'a RustConnection,
        deadline: Deadline,
    ) -> Result<Self, ControlError> {
        if deadline.is_expired() {
            return Err(ControlError::TimedOut);
        }
        let cutoff = IoCutoff::arm(connection.stream().as_fd(), deadline.remaining())
            .map_err(|_| ControlError::SendFailed)?;
        connection
            .grab_server()
            .map_err(|_| ControlError::SendFailed)?
            .check()
            .map_err(|_| ControlError::SendFailed)?;
        Ok(Self {
            connection,
            _cutoff: cutoff,
        })
    }
}

impl Drop for ServerGrab<'_> {
    fn drop(&mut self) {
        let _ = self.connection.ungrab_server();
        let _ = self.connection.flush();
    }
}
