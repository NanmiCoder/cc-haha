use super::sock_buf_info::SockBufInfo;
use super::socket_metadata::SocketMetadata;
use super::socket_protocol_info::SocketProtocolInfo;

#[repr(C)]
pub(crate) struct SocketInfo {
    pub(crate) stat: libc::vinfo_stat,
    pub(crate) metadata: SocketMetadata,
    pub(crate) receive: SockBufInfo,
    pub(crate) send: SockBufInfo,
    pub(crate) kind: i32,
    pub(crate) reserved: u32,
    pub(crate) protocol_info: SocketProtocolInfo,
}
