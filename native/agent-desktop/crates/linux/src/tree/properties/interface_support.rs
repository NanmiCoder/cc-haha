use zbus::Connection;

use super::node_read::call;
use crate::system::ACCESSIBLE_INTERFACE;
use crate::tree::AtspiElement;

/// Optional interfaces must be advertised before any of their methods or
/// properties are queried: unsupported calls can crash Qt's AT-SPI bridge.
pub(crate) async fn supports(
    connection: &Connection,
    element: &AtspiElement,
    interface: &str,
) -> Result<bool, zbus::Error> {
    let reply = call(
        connection,
        element,
        ACCESSIBLE_INTERFACE,
        "GetInterfaces",
        &(),
    )
    .await?;
    let interfaces = reply.body().deserialize::<Vec<String>>()?;
    Ok(interfaces.iter().any(|name| name == interface))
}

#[cfg(test)]
#[path = "interface_support_tests.rs"]
mod tests;
