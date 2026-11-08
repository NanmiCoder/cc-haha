#[repr(C)]
#[derive(Clone, Copy)]
pub(crate) struct ProcFileInfo {
    pub(crate) open_flags: u32,
    pub(crate) status: u32,
    pub(crate) offset: i64,
    pub(crate) file_type: i32,
    pub(crate) guard_flags: u32,
}
