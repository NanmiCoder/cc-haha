use agent_desktop_core::{AdapterError, DeliverySemantics};

use crate::system::display::display_server::{DisplayServer, session_server};

pub(crate) use crate::system::display::route::Route as Backend;

pub(crate) fn backend() -> Result<Backend, AdapterError> {
    select(session_server())
}

pub(crate) fn select(server: DisplayServer) -> Result<Backend, AdapterError> {
    crate::system::display::route::resolve(server).map_err(|mut error| {
        error.details.get_or_insert_with(|| serde_json::json!({}))["physical_delivery_started"] =
            false.into();
        error.with_disposition(DeliverySemantics::not_delivered())
    })
}

#[cfg(test)]
#[path = "backend_tests.rs"]
mod tests;
