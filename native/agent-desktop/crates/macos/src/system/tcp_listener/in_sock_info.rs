use super::in_sock_flow::InSockFlow;
use super::in_sock_ipv6::InSockIpv6;
use super::in_sock_ports::InSockPorts;

#[repr(C)]
#[derive(Clone, Copy)]
pub(crate) struct InSockInfo {
    pub(crate) ports: InSockPorts,
    pub(crate) generation: u64,
    pub(crate) flow: InSockFlow,
    pub(crate) addresses: [[u64; 2]; 2],
    pub(crate) ipv4_tos: u8,
    pub(crate) ipv6: InSockIpv6,
}
