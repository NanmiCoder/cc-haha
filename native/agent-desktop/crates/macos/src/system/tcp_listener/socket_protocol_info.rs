use super::tcp_sock_info::TcpSockInfo;

#[repr(C)]
pub(crate) union SocketProtocolInfo {
    pub(crate) tcp: TcpSockInfo,
    pub(crate) reserved: [u64; 66],
}
