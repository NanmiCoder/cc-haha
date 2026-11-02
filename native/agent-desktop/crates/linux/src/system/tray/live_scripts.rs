pub(super) const SNI_FIXTURE: &str = r#"
import os, signal, sys
import gi
from gi.repository import Gio, GLib

LOG = os.environ["AD_TRAY_LOG"]
mode = sys.argv[1]
tag = sys.argv[2]


def log(*parts):
    with open(LOG, "a") as handle:
        handle.write(" ".join(str(part) for part in parts) + "\n")


bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
loop = GLib.MainLoop()
WATCHER = "org.kde.StatusNotifierWatcher"

if mode == "watcher":
    registered = []
    xml = """<node><interface name="org.kde.StatusNotifierWatcher">
      <method name="RegisterStatusNotifierItem"><arg type="s" direction="in"/></method>
      <method name="RegisterStatusNotifierHost"><arg type="s" direction="in"/></method>
      <property name="RegisteredStatusNotifierItems" type="as" access="read"/>
      <property name="IsStatusNotifierHostRegistered" type="b" access="read"/>
      <property name="ProtocolVersion" type="i" access="read"/>
    </interface></node>"""

    def on_call(conn, sender, path, iface, method, params, invocation):
        if method == "RegisterStatusNotifierItem":
            arg = params.unpack()[0]
            entry = "%s@%s" % (sender, arg) if arg.startswith("/") else arg
            if entry not in registered:
                registered.append(entry)
            log("watcher registered", entry)
        invocation.return_value(None)

    def on_get(conn, sender, path, iface, prop):
        if prop == "RegisteredStatusNotifierItems":
            return GLib.Variant("as", list(registered))
        if prop == "IsStatusNotifierHostRegistered":
            return GLib.Variant("b", True)
        return GLib.Variant("i", 0)

    info = Gio.DBusNodeInfo.new_for_xml(xml).interfaces[0]
    bus.register_object("/StatusNotifierWatcher", info, on_call, on_get, None)
    Gio.bus_own_name_on_connection(bus, WATCHER, Gio.BusNameOwnerFlags.NONE, None, None)

    def prune(conn, sender, path, iface, signal_name, params):
        gone = params.unpack()[0]
        for entry in list(registered):
            if entry.startswith(gone + "@") or entry == gone:
                registered.remove(entry)
                log("watcher dropped", entry)

    bus.signal_subscribe(
        "org.freedesktop.DBus", "org.freedesktop.DBus", "NameOwnerChanged",
        "/org/freedesktop/DBus", None, Gio.DBusSignalFlags.NONE,
        lambda conn, sender, path, iface, name, params: (
            prune(conn, sender, path, iface, name, GLib.Variant("(s)", (params.unpack()[0],)))
            if params.unpack()[2] == "" else None
        ),
    )
    log("ready", tag)
    loop.run()
    sys.exit(0)

title = sys.argv[3]
menu_mode = sys.argv[4]
state = {"status": "Active", "revision": 1, "checked": 0, "fail_layout": False}
signal_methods = {
    "kde": ["Activate", "ContextMenu", "SecondaryActivate", "Scroll"],
    "ayatana": ["Scroll", "SecondaryActivate", "XAyatanaSecondaryActivate"],
}[mode]
item_path = "/StatusNotifierItem" if mode == "kde" else "/org/ayatana/NotificationItem/" + tag
menu_path = "/MenuBar"

methods_xml = ""
for name in signal_methods:
    if name == "Scroll":
        args = '<arg type="i" direction="in"/><arg type="s" direction="in"/>'
    elif name == "XAyatanaSecondaryActivate":
        args = '<arg type="u" direction="in"/>'
    else:
        args = '<arg type="i" direction="in"/><arg type="i" direction="in"/>'
    methods_xml += '<method name="%s">%s</method>' % (name, args)
menu_prop = '' if menu_mode == "none" else '<property name="Menu" type="o" access="read"/>'
item_xml = """<node><interface name="org.kde.StatusNotifierItem">
  %s
  <property name="Title" type="s" access="read"/>
  <property name="Id" type="s" access="read"/>
  <property name="Status" type="s" access="read"/>
  <property name="ItemIsMenu" type="b" access="read"/>
  <property name="IconName" type="s" access="read"/>
  %s
</interface></node>""" % (methods_xml, menu_prop)


def on_item_call(conn, sender, path, iface, method, params, invocation):
    log("item", tag, "method", method, *params.unpack())
    invocation.return_value(None)


def on_item_get(conn, sender, path, iface, prop):
    if prop == "Title":
        return GLib.Variant("s", title)
    if prop == "Id":
        return GLib.Variant("s", tag)
    if prop == "Status":
        return GLib.Variant("s", state["status"])
    if prop == "Menu":
        return GLib.Variant("o", menu_path)
    if prop == "ItemIsMenu":
        return GLib.Variant("b", False)
    return GLib.Variant("s", "icon")


def entry(entry_id, props, children=()):
    return GLib.Variant(
        "(ia{sv}av)",
        (entry_id, props, [GLib.Variant("(ia{sv}av)", child) for child in children]),
    )


def tuple_entry(entry_id, props, children=()):
    return (entry_id, props, [GLib.Variant("(ia{sv}av)", child) for child in children])


def layout():
    s = lambda v: GLib.Variant("s", v)
    b = lambda v: GLib.Variant("b", v)
    i = lambda v: GLib.Variant("i", v)
    kids = [
        tuple_entry(1, {"label": s("_Open")}),
        tuple_entry(2, {"type": s("separator")}),
        tuple_entry(3, {"label": s("Disabled"), "enabled": b(False)}),
        tuple_entry(4, {"label": s("Check"), "toggle-type": s("checkmark"), "toggle-state": i(state["checked"])}),
        tuple_entry(
            5,
            {"label": s("More"), "children-display": s("submenu")},
            [tuple_entry(6, {"label": s("Child")})],
        ),
    ]
    return GLib.Variant(
        "(u(ia{sv}av))",
        (state["revision"], tuple_entry(0, {"children-display": s("submenu")}, kids)),
    )


menu_xml = """<node><interface name="com.canonical.dbusmenu">
  <method name="GetLayout"><arg type="i" direction="in"/><arg type="i" direction="in"/><arg type="as" direction="in"/><arg type="u" direction="out"/><arg type="(ia{sv}av)" direction="out"/></method>
  <method name="Event"><arg type="i" direction="in"/><arg type="s" direction="in"/><arg type="v" direction="in"/><arg type="u" direction="in"/></method>
  <method name="AboutToShow"><arg type="i" direction="in"/><arg type="b" direction="out"/></method>
  <property name="Version" type="u" access="read"/>
  <property name="Status" type="s" access="read"/>
</interface></node>"""


def on_menu_call(conn, sender, path, iface, method, params, invocation):
    if method == "GetLayout":
        log("menu", tag, "GetLayout")
        if state["fail_layout"]:
            invocation.return_dbus_error("org.freedesktop.DBus.Error.Failed", "layout read refused")
        else:
            invocation.return_value(layout())
    elif method == "Event":
        entry_id, kind, _data, _stamp = params.unpack()
        log("menu", tag, "Event", entry_id, kind)
        if entry_id == 4 and kind == "clicked":
            state["checked"] = 0 if state["checked"] else 1
            state["revision"] += 1
        invocation.return_value(None)
    elif method == "AboutToShow":
        log("menu", tag, "AboutToShow", params.unpack()[0])
        invocation.return_value(GLib.Variant("(b)", (False,)))
    else:
        invocation.return_value(None)


def on_menu_get(conn, sender, path, iface, prop):
    return GLib.Variant("u", 3) if prop == "Version" else GLib.Variant("s", "normal")


item_info = Gio.DBusNodeInfo.new_for_xml(item_xml).interfaces[0]
bus.register_object(item_path, item_info, on_item_call, on_item_get, None)
if menu_mode != "none":
    menu_info = Gio.DBusNodeInfo.new_for_xml(menu_xml).interfaces[0]
    bus.register_object(menu_path, menu_info, on_menu_call, on_menu_get, None)

well_known = "org.agentdesktop.TrayFixture." + tag
if mode == "kde":
    Gio.bus_own_name_on_connection(bus, well_known, Gio.BusNameOwnerFlags.NONE, None, None)
GLib.usleep(200000)
argument = well_known if mode == "kde" else item_path
bus.call_sync(
    WATCHER, "/StatusNotifierWatcher", WATCHER, "RegisterStatusNotifierItem",
    GLib.Variant("(s)", (argument,)), None, Gio.DBusCallFlags.NONE, 5000, None,
)


def passive():
    state["status"] = "Passive" if state["status"] == "Active" else "Active"
    log("status", tag, state["status"])
    return True


GLib.unix_signal_add(GLib.PRIORITY_DEFAULT, signal.SIGUSR1, passive)
def toggle_layout():
    state["fail_layout"] = not state["fail_layout"]
    log("layout", tag, "refused" if state["fail_layout"] else "readable")
    return True

GLib.unix_signal_add(GLib.PRIORITY_DEFAULT, signal.SIGUSR2, toggle_layout)
def toggle_unknown_status():
    state["status"] = "Active" if state["status"] == "unreadable" else "unreadable"
    log("status", tag, state["status"])
    return True

GLib.unix_signal_add(GLib.PRIORITY_DEFAULT, signal.SIGWINCH, toggle_unknown_status)
log("ready", tag, bus.get_unique_name())
loop.run()
"#;
