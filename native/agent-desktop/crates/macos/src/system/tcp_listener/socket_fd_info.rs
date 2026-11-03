use super::proc_file_info::ProcFileInfo;
use super::socket_info::SocketInfo;

#[repr(C)]
pub(crate) struct SocketFdInfo {
    pub(crate) file: ProcFileInfo,
    pub(crate) socket: SocketInfo,
}
