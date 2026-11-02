mod adapter;
pub(crate) mod app;
pub(crate) mod bus;
pub(crate) mod capture;
pub(crate) mod close;
pub(crate) mod context;
pub(crate) mod display;
pub(crate) mod focus;
pub(crate) mod interaction;
pub(crate) mod launch;
pub(crate) mod menu;
pub(crate) mod overlay;
pub(crate) mod permissions;
pub(crate) mod process;
pub(crate) mod registry;
pub(crate) mod shell;
pub(crate) mod signal;
pub(crate) mod tray;
pub(crate) mod window;
pub(crate) mod x11;

pub(crate) use app::app_name::app_name as listed_app_name;
pub(crate) use bus::bus_deadline::within;
pub(crate) use bus::bus_fault::{NAME_HAS_NO_OWNER, SERVICE_UNKNOWN};
pub(crate) use bus::bus_process::{owner_process_id, process_id};
pub(crate) use bus::{
    ACCESSIBLE_INTERFACE, PROPERTIES_INTERFACE, SharedBus, classify, is_connection_failure,
};
pub(crate) use bus::{REGISTRY_ROOT_PATH, REGISTRY_SERVICE};

pub(crate) use app::app_ops::{inventory as app_inventory, scoped as apps_scoped};
pub(crate) use display::{list_displays, list_wayland_displays};
pub(crate) use menu::surfaces::list_surfaces;
pub(crate) use window::window_ops::{focused_window, list_windows};
pub(crate) use window::window_resolve::resolve_window_strict;
