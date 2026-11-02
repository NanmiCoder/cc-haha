#[repr(C)]
#[derive(Clone, Copy)]
pub(crate) struct ProcFdInfo {
    pub(crate) fd: i32,
    pub(crate) fd_type: u32,
}
