use agent_desktop_core::{AdapterError, Deadline, ProcessIdentity};
use windows_sys::Win32::NetworkManagement::IpHelper::{
    GetExtendedTcpTable, MIB_TCP_STATE_LISTEN, MIB_TCPROW_OWNER_PID, MIB_TCPTABLE_OWNER_PID,
    TCP_TABLE_OWNER_PID_ALL,
};
use windows_sys::Win32::Networking::WinSock::AF_INET;

pub(crate) fn owns_listener(
    process: &ProcessIdentity,
    port: u16,
    deadline: Deadline,
) -> Result<bool, AdapterError> {
    if !crate::system::process_identity::matches_instance(process.pid, &process.instance)? {
        return Ok(false);
    }
    if deadline.is_expired() {
        return Err(AdapterError::timeout(
            "Checking the DevTools listener owner",
        ));
    }
    let mut size = 0;
    let result = unsafe {
        GetExtendedTcpTable(
            std::ptr::null_mut(),
            &mut size,
            0,
            AF_INET as u32,
            TCP_TABLE_OWNER_PID_ALL,
            0,
        )
    };
    if result != 122 || size < std::mem::size_of::<u32>() as u32 {
        return Err(AdapterError::internal(
            "Windows could not size the TCP owner table",
        ));
    }
    let mut buffer = vec![0_u32; size.div_ceil(4) as usize];
    let result = unsafe {
        GetExtendedTcpTable(
            buffer.as_mut_ptr().cast(),
            &mut size,
            0,
            AF_INET as u32,
            TCP_TABLE_OWNER_PID_ALL,
            0,
        )
    };
    if result != 0 {
        return Err(AdapterError::internal(
            "Windows could not read the TCP owner table",
        ));
    }
    let table = unsafe { &*buffer.as_ptr().cast::<MIB_TCPTABLE_OWNER_PID>() };
    let rows =
        unsafe { std::slice::from_raw_parts(table.table.as_ptr(), table.dwNumEntries as usize) };
    Ok(rows.iter().any(|row: &MIB_TCPROW_OWNER_PID| {
        row.dwState == MIB_TCP_STATE_LISTEN as u32
            && u16::from_be(row.dwLocalPort as u16) == port
            && u32::from_be(row.dwLocalAddr) == 0x7f00_0001
            && row.dwOwningPid == u32::from(process.pid)
    }))
}

#[cfg(test)]
#[path = "tcp_listener_tests.rs"]
mod tests;
