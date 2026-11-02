use super::in_sock_info::InSockInfo;

#[repr(C)]
#[derive(Clone, Copy)]
pub(crate) struct TcpSockInfo {
    pub(crate) network: InSockInfo,
    pub(crate) state: i32,
    pub(crate) timers: [i32; 4],
    pub(crate) mss: i32,
    pub(crate) flags: u32,
    pub(crate) reserved: u32,
    pub(crate) tcp_control_block: u64,
}
