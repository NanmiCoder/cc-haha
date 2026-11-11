#[repr(C)]
#[derive(Clone, Copy)]
pub(crate) struct InSockIpv6 {
    pub(crate) hop_limit: u8,
    pub(crate) checksum: i32,
    pub(crate) interface_index: u16,
    pub(crate) hops: i16,
}
