use agent_desktop_core::AdapterError;
use futures_util::future::join;
use zbus::Connection;
use zbus::zvariant::OwnedValue;

use super::node_read::call;
use crate::system::process::toolkit_id::ToolkitId;
use crate::system::process::web_family::WebFamily;
use crate::system::{PROPERTIES_INTERFACE, REGISTRY_ROOT_PATH};
use crate::tree::AtspiElement;
use crate::tree::capabilities::text_units::LengthUnit;

const APPLICATION_INTERFACE: &str = "org.a11y.atspi.Application";

async fn application_text(
    connection: &Connection,
    root: &AtspiElement,
    property: &'static str,
) -> Result<Option<String>, AdapterError> {
    let reply = match call(
        connection,
        root,
        PROPERTIES_INTERFACE,
        "Get",
        &(APPLICATION_INTERFACE, property),
    )
    .await
    {
        Ok(reply) => reply,
        Err(error) if crate::system::is_connection_failure(&error) => {
            return Err(crate::system::classify(&error));
        }
        Err(_) => return Ok(None),
    };
    Ok(reply
        .body()
        .deserialize::<OwnedValue>()
        .ok()
        .and_then(|value| value.downcast_ref::<&str>().ok().map(str::to_owned)))
}

/// The toolkit an application root advertises, read one property at a time.
/// Bulk property reads can crash the Qt AT-SPI bridge (L41-7).
pub(crate) async fn read_toolkit(
    connection: &Connection,
    root: &AtspiElement,
) -> Result<ToolkitId, AdapterError> {
    match super::interface_support::supports(connection, root, APPLICATION_INTERFACE).await {
        Ok(true) => {}
        Err(error) if crate::system::is_connection_failure(&error) => {
            return Err(crate::system::classify(&error));
        }
        _ => {
            return Ok(ToolkitId {
                name: None,
                version: None,
            });
        }
    }
    let (name, version) = join(
        application_text(connection, root, "ToolkitName"),
        application_text(connection, root, "Version"),
    )
    .await;
    Ok(ToolkitId {
        name: name?,
        version: version?,
    })
}

/// The web engine the application reports, independent of process identity.
pub(crate) fn web_family(toolkit: &ToolkitId) -> Option<WebFamily> {
    if kind(toolkit) == ToolkitKind::Chromium {
        Some(WebFamily::Chromium)
    } else if is_gecko(toolkit) {
        Some(WebFamily::Gecko)
    } else {
        None
    }
}

pub(crate) async fn read_web_family(
    connection: &Connection,
    element: &AtspiElement,
) -> Result<Option<WebFamily>, AdapterError> {
    let root = AtspiElement::new(element.bus_name(), REGISTRY_ROOT_PATH, element.pid());
    Ok(web_family(&read_toolkit(connection, &root).await?))
}

/// The toolkits whose accessibility geometry has been measured.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ToolkitKind {
    Gtk3,
    Gtk4,
    Qt,
    Chromium,
    Other,
}

fn gtk_major(version: Option<&str>) -> Option<u32> {
    version?.split('.').next()?.parse().ok()
}

/// The toolkit a root names. A GTK root with no readable major version is not
/// guessed at, because the major decides which coordinate model applies.
pub(crate) fn kind(toolkit: &ToolkitId) -> ToolkitKind {
    let Some(name) = toolkit.name.as_deref() else {
        return ToolkitKind::Other;
    };
    if name.eq_ignore_ascii_case("gtk") {
        return match gtk_major(toolkit.version.as_deref()) {
            Some(major) if major < 4 => ToolkitKind::Gtk3,
            Some(_) => ToolkitKind::Gtk4,
            None => ToolkitKind::Other,
        };
    }
    if name.eq_ignore_ascii_case("qt") {
        ToolkitKind::Qt
    } else if name.eq_ignore_ascii_case("chromium") {
        ToolkitKind::Chromium
    } else {
        ToolkitKind::Other
    }
}

/// Whether a combo box's own `Selection` follows the application: GTK 3 only.
/// A Qt combo reports the selection of its popup view, which moves while the
/// combo keeps its value (L30-25, L30-40).
pub(crate) fn combo_selection_is_live(toolkit: &ToolkitId) -> bool {
    kind(toolkit) == ToolkitKind::Gtk3
}

/// Whether a combo box's accessible name is its shown value. Only Qt is
/// proven to name the combo by its current text; GTK 3 and Chromium let the
/// application name it with a label (`set_name`, `aria-label`).
pub(crate) fn combo_name_is_value(toolkit: &ToolkitId) -> bool {
    kind(toolkit) == ToolkitKind::Qt
}

/// Whether the root names Gecko, whose `SetTextContents` and `InsertText`
/// answer `true` and change nothing (L30-14).
pub(crate) fn is_gecko(toolkit: &ToolkitId) -> bool {
    toolkit
        .name
        .as_deref()
        .is_some_and(|name| name.eq_ignore_ascii_case("gecko"))
}

/// The unit the toolkit counts the `InsertText` length in: Qt in UTF-16
/// units, every other toolkit in bytes (L30-38).
pub(crate) fn insert_length_unit(toolkit: &ToolkitId) -> LengthUnit {
    match kind(toolkit) {
        ToolkitKind::Qt => LengthUnit::Utf16Units,
        _ => LengthUnit::Utf8Bytes,
    }
}

/// Whether the toolkit reports screen positions that are global: GTK 3, Qt and
/// Chromium. GTK 4 reports `[0, 0, w, h]` for nearly every node, and a toolkit
/// that could not be read is not assumed to report anything.
pub(crate) fn reports_global_position(toolkit: &ToolkitId) -> bool {
    matches!(
        kind(toolkit),
        ToolkitKind::Gtk3 | ToolkitKind::Qt | ToolkitKind::Chromium
    )
}

/// Whether window-coordinate descent is usable after sibling overlap has
/// been excluded. GTK 3 and Qt can descend beneath an overlapping sibling;
/// neither their child order nor their component z-order proves stacking.
/// GTK 4 qualifies in window coordinates only.
pub(crate) fn trusts_descent(toolkit: &ToolkitId) -> bool {
    kind(toolkit) != ToolkitKind::Other
}

/// Whether a landing on a node outside the target's ancestry in the same
/// window, after sibling overlap is excluded, is evidence of interception.
/// That needs a measured
/// self-hit rate of 100% at the centres of visible nodes: GTK 3 and Qt reach
/// it; GTK 4 (3 of 9 on Text Editor) and Chromium, whose Electron hosts land
/// on unrelated nodes for 60 of 60, do not.
pub(crate) fn trusts_same_window_landing(toolkit: &ToolkitId) -> bool {
    matches!(kind(toolkit), ToolkitKind::Gtk3 | ToolkitKind::Qt)
}

/// Whether the point query stops at a container of the target instead of
/// descending into it. GTK 4 answers a panel of the window and then nothing
/// for the centre of a list, a row and a cell alike, so the landing alone
/// cannot tell a covered target from an uncovered one.
pub(crate) fn stops_above_target(toolkit: &ToolkitId) -> bool {
    kind(toolkit) == ToolkitKind::Gtk4
}

#[cfg(test)]
#[path = "toolkit_trust_tests.rs"]
mod tests;
