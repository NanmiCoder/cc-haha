use x11rb::protocol::xproto::ConnectionExt;
use x11rb::rust_connection::RustConnection;

use super::grab_error::{GrabError, unreadable};

pub(crate) fn read(connection: &RustConnection, screen: usize) -> Result<bool, GrabError> {
    let atom = connection
        .intern_atom(false, format!("_NET_WM_CM_S{screen}").as_bytes())
        .map_err(unreadable)?
        .reply()
        .map_err(unreadable)?
        .atom;
    let owner = connection
        .get_selection_owner(atom)
        .map_err(unreadable)?
        .reply()
        .map_err(unreadable)?
        .owner;
    Ok(owner != x11rb::NONE)
}
