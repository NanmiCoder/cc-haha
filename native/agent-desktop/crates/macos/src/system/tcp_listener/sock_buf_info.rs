#[repr(C)]
#[derive(Clone, Copy)]
pub(crate) struct SockBufInfo {
    pub(crate) values: [u32; 5],
    pub(crate) flags: i16,
    pub(crate) timeout: i16,
}
