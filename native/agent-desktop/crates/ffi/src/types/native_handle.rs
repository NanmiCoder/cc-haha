#[repr(C)]
pub struct AdNativeHandle {
    /// Opaque thread-affine registry token, never an allocation or OS pointer.
    pub ptr: *const std::ffi::c_void,
}
