use std::os::unix::fs::FileTypeExt;
use std::path::Path;

use super::display_server::Probe;
use crate::system::display::display_reach::Reach;

const UNIX_TABLE: &str = "/proc/net/unix";
const X11_SOCKET_DIR: &str = "/tmp/.X11-unix";
const LISTENING: u32 = 0x0001_0000;

/// Probes display endpoints without connecting to them, by reading the
/// kernel's table of unix sockets. A connection opened and dropped without a
/// handshake makes some X servers reset the next client that connects right
/// after it, and the readers that follow a probe are exactly that client.
pub(crate) struct SocketProbe;

fn is_listening(table: &str, path: &str) -> bool {
    let abstract_path = format!("@{path}");
    table.lines().skip(1).any(|line| {
        let fields: Vec<&str> = line.split_whitespace().collect();
        let bound = fields
            .last()
            .is_some_and(|name| *name == path || *name == abstract_path);
        let flags = fields
            .get(3)
            .and_then(|flags| u32::from_str_radix(flags, 16).ok());
        bound && fields.len() >= 8 && flags.is_some_and(|flags| flags & LISTENING != 0)
    })
}

/// What the socket table and the file system say about a unix socket path: a
/// listener is reachable, a socket file nobody listens on is refusing, and
/// neither is missing.
pub(crate) fn reach_from(table: &str, path: &str, file_is_socket: bool) -> Reach {
    if is_listening(table, path) {
        Reach::Connected
    } else if file_is_socket {
        Reach::Refused
    } else {
        Reach::Missing
    }
}

fn reach(path: &str) -> Reach {
    let table = std::fs::read_to_string(UNIX_TABLE).unwrap_or_default();
    let is_socket = std::fs::symlink_metadata(path).is_ok_and(|meta| meta.file_type().is_socket());
    reach_from(&table, path, is_socket)
}

/// The number of a local display name, without any screen suffix (`:1`,
/// `unix:1`). A name that carries a host is not local and is not probed.
fn local_number(display: &str) -> Option<&str> {
    let rest = display.strip_prefix("unix").unwrap_or(display);
    let rest = rest.strip_prefix(':')?;
    let number = rest.split('.').next()?;
    (!number.is_empty() && number.bytes().all(|byte| byte.is_ascii_digit())).then_some(number)
}

impl Probe for SocketProbe {
    fn wayland(&self, socket: &Path) -> Reach {
        reach(&socket.to_string_lossy())
    }

    fn x11(&self, display: &str) -> Reach {
        match local_number(display) {
            Some(number) => reach(&format!("{X11_SOCKET_DIR}/X{number}")),
            None => Reach::Connected,
        }
    }
}

#[cfg(test)]
#[path = "display_probe_tests.rs"]
mod tests;
