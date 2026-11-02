#[cfg(target_os = "windows")]
pub(crate) mod capture_backend;
#[cfg(target_os = "windows")]
pub(crate) mod capture_d3d;
#[cfg(target_os = "windows")]
pub(crate) mod capture_display;
#[cfg(target_os = "windows")]
pub(crate) mod capture_envelope_parity;
#[cfg(target_os = "windows")]
pub(crate) mod capture_modern;
#[cfg(all(test, target_os = "windows"))]
pub(crate) mod capture_test_support;
#[cfg(target_os = "windows")]
pub(crate) mod capture_window;
#[cfg(target_os = "windows")]
pub(crate) mod gdi_surface;
#[cfg(target_os = "windows")]
pub(crate) mod png_codec;
#[cfg(target_os = "windows")]
pub(crate) mod screenshot;

#[cfg(target_os = "windows")]
pub(crate) mod native_call;
