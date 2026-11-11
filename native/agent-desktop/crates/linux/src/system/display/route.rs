use agent_desktop_core::AdapterError;

use super::display_server::{DisplayServer, session_server};
use crate::system::display;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Route {
    X11(String),
    Wayland,
}

pub(crate) fn resolve(server: DisplayServer) -> Result<Route, AdapterError> {
    match server {
        DisplayServer::X11(display) => Ok(Route::X11(display)),
        DisplayServer::Wayland => Ok(Route::Wayland),
        DisplayServer::Unavailable(why) => Err(display::unreachable(why)),
    }
}

pub(crate) fn current() -> Result<Route, AdapterError> {
    resolve(session_server())
}

#[cfg(test)]
#[path = "route_tests.rs"]
mod tests;
