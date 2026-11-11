use std::collections::HashSet;

use agent_desktop_core::{AdapterError, Deadline, ProcessIdentity};

use super::process_lookup::Lookup;

pub(crate) fn owns_listener(
    process: &ProcessIdentity,
    port: u16,
    deadline: Deadline,
) -> Result<bool, AdapterError> {
    match super::process_facts::lookup(process.pid.get()) {
        Lookup::Found(facts) if facts.instance == process.instance => {}
        Lookup::Found(_) | Lookup::Gone => return Ok(false),
        Lookup::Unreadable => return Err(unavailable("process identity could not be read")),
    }
    let inodes = listening_inodes(port)?;
    if inodes.is_empty() {
        return Ok(false);
    }
    let fds = std::fs::read_dir(format!("/proc/{}/fd", process.pid.get()))
        .map_err(|_| unavailable("process file descriptors could not be read"))?;
    for fd in fds {
        if deadline.is_expired() {
            return Err(AdapterError::timeout(
                "Checking the DevTools listener owner",
            ));
        }
        let fd = fd.map_err(|_| unavailable("process file descriptors could not be read"))?;
        match std::fs::read_link(fd.path()) {
            Ok(target) if inodes.contains(target.to_string_lossy().as_ref()) => return Ok(true),
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err(unavailable("process file descriptors could not be read")),
        }
    }
    Ok(false)
}

fn listening_inodes(port: u16) -> Result<HashSet<String>, AdapterError> {
    let mut inodes = HashSet::new();
    let contents = std::fs::read_to_string("/proc/net/tcp")
        .map_err(|_| unavailable("the TCP socket table could not be read"))?;
    for line in contents.lines().skip(1) {
        let fields: Vec<_> = line.split_whitespace().collect();
        if fields.get(3) != Some(&"0A") || !is_loopback(fields.get(1), port) {
            continue;
        }
        if let Some(inode) = fields.get(9)
            && !inode.is_empty()
        {
            inodes.insert(format!("socket:[{inode}]"));
        }
    }
    Ok(inodes)
}

fn is_loopback(address: Option<&&str>, port: u16) -> bool {
    let Some((address, raw_port)) = address.and_then(|value| value.rsplit_once(':')) else {
        return false;
    };
    let Ok(raw_port) = u16::from_str_radix(raw_port, 16) else {
        return false;
    };
    raw_port == port && address == "0100007F"
}

fn unavailable(message: &str) -> AdapterError {
    AdapterError::internal(message)
}

#[cfg(test)]
#[path = "tcp_listener_tests.rs"]
mod tests;
