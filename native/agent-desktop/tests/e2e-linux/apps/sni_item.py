from __future__ import annotations

import argparse
import json
import signal
import sys
from pathlib import Path

ITEM_SERVICE = "org.kde.StatusNotifierItem"
ITEM_PATH = "/StatusNotifierItem"
MENU_SERVICE = "com.canonical.dbusmenu"
MENU_PATH = "/MenuBar"
WATCHER_SERVICE = "org.kde.StatusNotifierWatcher"
WATCHER_PATH = "/StatusNotifierWatcher"

def item_xml(has_activate: bool = True) -> str:
    methods = [
        '<method name="SecondaryActivate"><arg type="i" direction="in"/><arg type="i" direction="in"/></method>',
        '<method name="ContextMenu"><arg type="i" direction="in"/><arg type="i" direction="in"/></method>',
        '<method name="Scroll"><arg type="i" direction="in"/><arg type="s" direction="in"/></method>',
    ]
    if has_activate:
        methods.insert(
            0,
            '<method name="Activate"><arg type="i" direction="in"/><arg type="i" direction="in"/></method>',
        )
    return (
        '<node><interface name="org.kde.StatusNotifierItem">'
        '<property name="Category" type="s" access="read"/>'
        '<property name="Id" type="s" access="read"/>'
        '<property name="Title" type="s" access="read"/>'
        '<property name="Status" type="s" access="read"/>'
        '<property name="IconName" type="s" access="read"/>'
        '<property name="ItemIsMenu" type="b" access="read"/>'
        '<property name="Menu" type="o" access="read"/>'
        + "".join(methods)
        + "</interface></node>"
    )

MENU_XML = """
<node>
  <interface name="com.canonical.dbusmenu">
    <property name="Version" type="u" access="read"/>
    <property name="Status" type="s" access="read"/>
    <property name="TextDirection" type="s" access="read"/>
    <method name="GetLayout">
      <arg type="i" direction="in"/><arg type="i" direction="in"/>
      <arg type="as" direction="in"/>
      <arg type="u" direction="out"/><arg type="(ia{sv}av)" direction="out"/>
    </method>
    <method name="GetGroupProperties">
      <arg type="ai" direction="in"/><arg type="as" direction="in"/>
      <arg type="a(ia{sv})" direction="out"/>
    </method>
    <method name="Event">
      <arg type="i" direction="in"/><arg type="s" direction="in"/>
      <arg type="v" direction="in"/><arg type="u" direction="in"/>
    </method>
    <method name="AboutToShow"><arg type="i" direction="in"/><arg type="b" direction="out"/></method>
  </interface>
</node>
"""


def menu_entries(disabled_entry: bool = False) -> list[dict]:
    entries = [
        {"id": 1, "label": "Activate Harness Item", "enabled": True},
        {"id": 2, "label": "Quit Harness Item", "enabled": True},
    ]
    if disabled_entry:
        entries.append({"id": 3, "label": "Disabled Entry", "enabled": False})
    return entries


def log_call(path: Path, name: str, payload: dict) -> None:
    with open(path, "a", encoding="utf-8") as handle:
        handle.write(json.dumps({"call": name, "args": payload}, sort_keys=True) + "\n")


def parse_log_body(text: str) -> list[tuple[str, dict]]:
    calls: list[tuple[str, dict]] = []
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        record = json.loads(line)
        calls.append((record["call"], record.get("args", {})))
    return calls


def read_log(path: Path) -> list[tuple[str, dict]]:
    if not path.exists():
        return []
    return parse_log_body(path.read_text(encoding="utf-8"))


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(prog="sni_item")
    parser.add_argument("--log", required=True)
    parser.add_argument("--title", default="Harness Tray")
    parser.add_argument("--service", default="org.agentdesktop.HarnessTray")
    parser.add_argument("--no-activate", action="store_true")
    parser.add_argument("--no-menu", action="store_true")
    parser.add_argument("--disabled-entry", action="store_true")
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    import gi

    gi.require_version("Gio", "2.0")
    from gi.repository import Gio, GLib

    log_path = Path(args.log)
    bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    entries = menu_entries(args.disabled_entry)
    served = {"revision": 1}

    def layout_item(item):
        props = {
            "label": GLib.Variant("s", item["label"]),
            "enabled": GLib.Variant("b", item["enabled"]),
            "visible": GLib.Variant("b", True),
        }
        return (item["id"], props)

    def on_item_call(_connection, _sender, _path, _interface, method, params, invocation):
        values = list(params.unpack()) if params is not None else []
        log_call(log_path, method, {"values": values})
        invocation.return_value(None)

    def on_get_layout(_connection, _sender, _path, _interface, method, params, invocation):
        log_call(log_path, method, {"values": list(params.unpack())})
        root_props = {"children-display": GLib.Variant("s", "submenu")}
        children = [
            GLib.Variant(
                "(ia{sv}av)",
                (
                    item["id"],
                    layout_item(item)[1],
                    [],
                ),
            )
            for item in entries
        ]
        result = GLib.Variant(
            "(u(ia{sv}av))",
            (
                served["revision"],
                (0, root_props, children),
            ),
        )
        invocation.return_value(result)

    def on_group_properties(_connection, _sender, _path, _interface, method, params, invocation):
        log_call(log_path, method, {"ids": list(params.unpack()[0])})
        groups = [
            (item["id"], layout_item(item)[1])
            for item in entries
        ]
        invocation.return_value(GLib.Variant("(a(ia{sv}))", (groups,)))

    def on_event(_connection, _sender, _path, _interface, method, params, invocation):
        item_id, event_id, _data, _timestamp = params.unpack()
        log_call(log_path, method, {"id": item_id, "event": event_id})
        invocation.return_value(None)

    def on_about_to_show(_connection, _sender, _path, _interface, method, params, invocation):
        log_call(log_path, method, {"id": params.unpack()[0]})
        invocation.return_value(GLib.Variant("(b)", (False,)))

    def register(connection, _name):
        try:
            connection.call_sync(
                WATCHER_SERVICE,
                WATCHER_PATH,
                WATCHER_SERVICE,
                "RegisterStatusNotifierItem",
                GLib.Variant("(s)", (args.service,)),
                None,
                Gio.DBusCallFlags.NONE,
                5000,
                None,
            )
            log_call(log_path, "registered", {"service": args.service, "title": args.title})
        except GLib.Error as error:
            log_call(log_path, "register_failed", {"message": error.message})
        return False

    item_info = Gio.DBusNodeInfo.new_for_xml(item_xml(not args.no_activate)).interfaces[0]
    item_props = {
        "Category": GLib.Variant("s", "ApplicationStatus"),
        "Id": GLib.Variant("s", args.title),
        "Title": GLib.Variant("s", args.title),
        "Status": GLib.Variant("s", "Active"),
        "IconName": GLib.Variant("s", "application-x-executable"),
        "ItemIsMenu": GLib.Variant("b", args.no_activate),
        "Menu": GLib.Variant("o", MENU_PATH),
    }
    bus.register_object(
        ITEM_PATH,
        item_info,
        on_item_call,
        lambda _c, _s, _p, _i, name: item_props[name],
        None,
    )

    if not args.no_menu:
        menu_info = Gio.DBusNodeInfo.new_for_xml(MENU_XML).interfaces[0]
        menu_props = {
            "Version": GLib.Variant("u", 3),
            "Status": GLib.Variant("s", "normal"),
            "TextDirection": GLib.Variant("s", "ltr"),
        }
        handlers = {
            "GetLayout": on_get_layout,
            "GetGroupProperties": on_group_properties,
            "Event": on_event,
            "AboutToShow": on_about_to_show,
        }
        bus.register_object(
            MENU_PATH,
            menu_info,
            lambda *call: handlers[call[4]](*call),
            lambda _c, _s, _p, _i, name: menu_props[name],
            None,
        )

    Gio.bus_own_name_on_connection(bus, args.service, Gio.BusNameOwnerFlags.NONE, register, None)

    loop = GLib.MainLoop()
    for signum in (signal.SIGTERM, signal.SIGINT):
        GLib.unix_signal_add(GLib.PRIORITY_DEFAULT, signum, loop.quit)
    loop.run()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
