#[repr(C)]
pub(crate) struct SocketMetadata {
    handles: [u64; 2],
    protocol: [i32; 3],
    options_and_queues: [i16; 7],
    error: u16,
    out_of_band_mark: u32,
}
