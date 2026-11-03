pub(crate) mod bus_lookup;
pub(crate) mod capture_env;
pub(crate) mod display;
pub(crate) mod fullscreen_route;
pub(crate) mod pixels;
pub(crate) mod png_encode;
pub(crate) mod wayland_crop;
pub(crate) mod wayland_file;
pub(crate) mod wayland_portal;
pub(crate) mod wayland_portal_bus;
pub(crate) mod wayland_portal_call;
pub(crate) mod window;
pub(crate) mod window_context;
pub(crate) mod window_obstruction;
pub(crate) mod window_unit;
pub(crate) mod window_xid;

#[cfg(test)]
mod capture_live_support;
#[cfg(test)]
mod capture_live_tests;
#[cfg(test)]
mod cursor_live_tests;
#[cfg(test)]
mod wayland_portal_live_monitors;
#[cfg(test)]
mod wayland_portal_live_process;
#[cfg(test)]
mod wayland_portal_live_support;
#[cfg(test)]
mod wayland_portal_live_tests;

pub(super) mod screenshot;
