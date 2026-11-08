use crate::types::image_format::AdImageFormat;

/// Opaque image-buffer handle returned by `ad_screenshot`. The backing
/// byte buffer and its length live inside the Rust-owned struct — a
/// consumer cannot accidentally desynchronize the pair and trigger a
/// heap-corruption double-free. Walk it through `ad_image_buffer_*`
/// accessors and free it with `ad_image_buffer_free`.
pub struct AdImageBuffer {
    pub(crate) data: Box<[u8]>,
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) format: AdImageFormat,
    pub(crate) scale_factor: f64,
}
