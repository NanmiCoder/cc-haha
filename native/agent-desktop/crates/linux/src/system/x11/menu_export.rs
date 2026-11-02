use agent_desktop_core::Deadline;
use x11rb::protocol::xproto::{AtomEnum, ConnectionExt, GetPropertyReply};

use super::control::ControlRead;
use super::control_display::{atoms, longs, open, route};

#[derive(Debug, Clone)]
pub(crate) struct MenuExport {
    pub(crate) bus_name: String,
    pub(crate) application_path: String,
    pub(crate) window_path: String,
    pub(crate) menubar_path: String,
}

pub(crate) fn read(client: u32, expected_pid: u32, deadline: Deadline) -> Option<MenuExport> {
    route(deadline, move |display| {
        read_export(&display, client, expected_pid)
            .map_or(ControlRead::Unavailable, ControlRead::Ready)
    })
    .ready()
}

fn read_export(display: &str, client: u32, expected_pid: u32) -> Option<MenuExport> {
    let (connection, _) = open(display)?;
    let named = atoms(
        &connection,
        &[
            b"_NET_WM_PID",
            b"UTF8_STRING",
            b"_GTK_UNIQUE_BUS_NAME",
            b"_GTK_APPLICATION_OBJECT_PATH",
            b"_GTK_WINDOW_OBJECT_PATH",
            b"_GTK_MENUBAR_OBJECT_PATH",
        ],
    )?;
    let [pid, utf8, bus, application, window, menubar] = named.as_slice() else {
        return None;
    };
    let pid_cookie = connection
        .get_property(false, client, *pid, AtomEnum::CARDINAL, 0, 1)
        .ok()?;
    let cookies = [bus, application, window, menubar]
        .into_iter()
        .map(|name| {
            connection
                .get_property(false, client, *name, *utf8, 0, 1_024)
                .ok()
        })
        .collect::<Option<Vec<_>>>()?;
    let reply = pid_cookie.reply().ok()?;
    if reply.type_ != u32::from(AtomEnum::CARDINAL)
        || longs(reply.format, &reply.value, reply.bytes_after)? != [expected_pid]
    {
        return None;
    }
    let values = cookies
        .into_iter()
        .map(|cookie| text(cookie.reply().ok()?, *utf8))
        .collect::<Option<Vec<_>>>()?;
    decode(<[String; 4]>::try_from(values).ok()?)
}

fn decode(
    [bus_name, application_path, window_path, menubar_path]: [String; 4],
) -> Option<MenuExport> {
    zbus::names::UniqueName::try_from(bus_name.as_str()).ok()?;
    for path in [&application_path, &window_path, &menubar_path] {
        zbus::zvariant::ObjectPath::try_from(path.as_str()).ok()?;
    }
    Some(MenuExport {
        bus_name,
        application_path,
        window_path,
        menubar_path,
    })
}

fn text(reply: GetPropertyReply, utf8: u32) -> Option<String> {
    if reply.type_ != utf8
        || reply.format != 8
        || reply.bytes_after != 0
        || reply.value.is_empty()
        || reply.value.len() > 4_096
    {
        return None;
    }
    String::from_utf8(reply.value).ok()
}

#[cfg(test)]
#[path = "menu_export_tests.rs"]
mod tests;
