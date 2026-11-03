#[repr(C)]
#[derive(Clone, Copy)]
pub(crate) struct InSockFlow {
    pub(crate) flags: u32,
    pub(crate) flow: u32,
    pub(crate) address_flags: u8,
    pub(crate) ttl: u8,
    pub(crate) reserved: u32,
}
