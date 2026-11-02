#![allow(dead_code)]

use agent_desktop_core::{AdapterError, Deadline, ProcessIdentity};
use std::mem::size_of;

pub(crate) mod in_sock_flow;
pub(crate) mod in_sock_info;
pub(crate) mod in_sock_ipv6;
pub(crate) mod in_sock_ports;
pub(crate) mod proc_fd_info;
pub(crate) mod proc_file_info;
pub(crate) mod sock_buf_info;
pub(crate) mod socket_fd_info;
pub(crate) mod socket_info;
pub(crate) mod socket_metadata;
pub(crate) mod socket_protocol_info;
pub(crate) mod tcp_sock_info;

use in_sock_info::InSockInfo;
use proc_fd_info::ProcFdInfo;
use socket_fd_info::SocketFdInfo;
use socket_info::SocketInfo;
use tcp_sock_info::TcpSockInfo;

const PROC_PIDFDSOCKETINFO: libc::c_int = 3;
const SOCKINFO_TCP: libc::c_int = 2;
const TSI_S_LISTEN: libc::c_int = 1;

pub(crate) fn owns_listener(
    process: &ProcessIdentity,
    port: u16,
    deadline: Deadline,
) -> Result<bool, AdapterError> {
    let pid = i32::try_from(process.pid.get())
        .map_err(|_| AdapterError::internal("Process id exceeds the macOS pid range"))?;
    if !crate::system::process::process_identity::matches_instance(pid, &process.instance)? {
        return Ok(false);
    }
    let mut fds = vec![ProcFdInfo { fd: 0, fd_type: 0 }; 8192];
    let returned = unsafe {
        libc::proc_pidinfo(
            pid,
            libc::PROC_PIDLISTFDS,
            0,
            fds.as_mut_ptr().cast(),
            (fds.len() * size_of::<ProcFdInfo>()) as i32,
        )
    };
    if returned < 0 || returned as usize >= fds.len() * size_of::<ProcFdInfo>() {
        return Err(AdapterError::internal(
            "macOS could not read the process descriptor list",
        ));
    }
    fds.truncate(returned as usize / size_of::<ProcFdInfo>());
    for fd in fds {
        if deadline.is_expired() {
            return Err(AdapterError::timeout(
                "Checking the DevTools listener owner",
            ));
        }
        let mut info = std::mem::MaybeUninit::<SocketFdInfo>::zeroed();
        let returned = unsafe {
            libc::proc_pidfdinfo(
                pid,
                fd.fd,
                PROC_PIDFDSOCKETINFO,
                info.as_mut_ptr().cast(),
                size_of::<SocketFdInfo>() as i32,
            )
        };
        let minimum = std::mem::offset_of!(SocketFdInfo, socket)
            + std::mem::offset_of!(SocketInfo, protocol_info)
            + size_of::<TcpSockInfo>();
        if returned < minimum as i32 {
            continue;
        }
        let info = unsafe { info.assume_init() };
        if info.socket.kind != SOCKINFO_TCP {
            continue;
        }
        let tcp = unsafe { info.socket.protocol_info.tcp };
        if tcp.state == TSI_S_LISTEN
            && u16::from_be(tcp.network.ports.local as u16) == port
            && loopback_ipv4(&tcp.network)
        {
            return Ok(true);
        }
    }
    Ok(false)
}

fn loopback_ipv4(network: &InSockInfo) -> bool {
    if network.flow.address_flags & 1 == 0 {
        return false;
    }
    let local = network.addresses[1][1].to_ne_bytes();
    u32::from_be_bytes([local[4], local[5], local[6], local[7]]) == 0x7f00_0001
}

#[cfg(test)]
#[path = "tcp_listener_tests.rs"]
mod tests;
