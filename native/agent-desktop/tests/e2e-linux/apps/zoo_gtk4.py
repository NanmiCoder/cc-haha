"""GTK4 widget zoo with independently observable effects."""

import json
import os
import sys
import time
from pathlib import Path

os.environ["GTK_USE_PORTAL"] = "0"
import gi

gi.require_version("Gtk", "4.0")
from gi.repository import GLib, Gtk


def main(argv):
    if len(argv) != 1:
        raise ValueError("expected the JSON-lines log path")
    log = Path(argv[0])
    GLib.set_prgname("zoo_gtk4.py")
    GLib.set_application_name("Zoo GTK4")
    Gtk.init()
    loop = GLib.MainLoop()
    resetting = False
    dialogs = []
    window = Gtk.Window(title="Zoo GTK4")
    window.set_default_size(600, 900)
    box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=3)
    window.set_child(box)

    def named(widget, name):
        widget.update_property([Gtk.AccessibleProperty.LABEL], [name])
        return widget

    def record(name, event, value=None):
        if not resetting:
            with log.open("a") as stream:
                stream.write(json.dumps(dict(widget=name, event=event, value=value,
                                             at=time.monotonic())) + "\n")
                stream.flush()

    window.connect("close-request", lambda *_: record("zoo", "closed") or loop.quit() or False)

    def add(widget, name):
        named(widget, name)
        box.append(widget)
        return widget

    def button(name, callback):
        widget = add(Gtk.Button(label=name), name)
        widget.connect("clicked", lambda *_: callback())
        return widget

    initial_focus = button("zoo-button", lambda: record("zoo-button", "activate"))
    toggle = add(Gtk.ToggleButton(label="zoo-toggle"), "zoo-toggle")
    check = add(Gtk.CheckButton(label="zoo-check"), "zoo-check")
    radio_a = add(Gtk.CheckButton(label="zoo-radio-a"), "zoo-radio-a")
    radio_b = add(Gtk.CheckButton(label="zoo-radio-b"), "zoo-radio-b")
    radio_b.set_group(radio_a)
    radio_a.set_active(True)
    for widget, name in ((toggle, "zoo-toggle"), (check, "zoo-check")):
        widget.connect("toggled", lambda w, n=name: record(n, "toggled", w.get_active()))
    for widget, name in ((radio_a, "zoo-radio-a"), (radio_b, "zoo-radio-b")):
        widget.connect("toggled", lambda w, n=name: w.get_active() and record(n, "selected", n))
    switch = add(Gtk.Switch(), "zoo-switch")
    switch.connect("notify::active", lambda w, *_: record("zoo-switch", "toggled", w.get_active()))
    combo = add(Gtk.DropDown.new_from_strings(["Alpha", "Bravo", "Charlie"]), "zoo-combo")
    combo.connect("notify::selected", lambda w, *_: record("zoo-combo", "changed", w.get_selected_item().get_string()))
    combo.get_first_child().connect("toggled", lambda w: record("zoo-combo", "opened", w.get_active()))
    spin = add(Gtk.SpinButton.new_with_range(0, 10, 1), "zoo-spin")
    scale = add(Gtk.Scale.new_with_range(Gtk.Orientation.HORIZONTAL, 0, 100, 1), "zoo-scale")
    for widget, name in ((spin, "zoo-spin"), (scale, "zoo-scale")):
        widget.connect("value-changed", lambda w, n=name: record(n, "changed", w.get_value()))
    entry = add(Gtk.Entry(), "zoo-entry")
    password = add(Gtk.Entry(), "zoo-password")
    password.set_visibility(False)
    for widget in (entry, password):
        widget.connect("activate", lambda w: w.set_text("activated"))
    entry.connect("changed", lambda w: record("zoo-entry", "changed", w.get_text()))
    password.connect("changed", lambda w: record("zoo-password", "changed", len(w.get_text())))
    for widget, name in ((entry, "zoo-entry"), (password, "zoo-password"),
                         (spin, "zoo-spin")):
        focus = Gtk.EventControllerFocus()
        focus.connect("enter", lambda _, n=name: record(n, "focus", True))
        widget.add_controller(focus)
    text = add(Gtk.TextView(), "zoo-text")
    text.set_size_request(-1, 60)
    buffer = text.get_buffer()
    buffer.connect("changed", lambda b: record("zoo-text", "changed", b.get_text(*b.get_bounds(), True)))
    menu_button = add(Gtk.MenuButton(label="zoo-menubutton"), "zoo-menubutton")
    menu = Gtk.Popover()
    item = named(Gtk.Button(label="zoo-menu-item"), "zoo-menu-item")

    def menu_activated(*_):
        record("zoo-menu-item", "activate")
        menu.popdown()

    item.connect("clicked", menu_activated)
    menu.set_child(item)
    menu_button.set_popover(menu)
    link = add(Gtk.LinkButton.new_with_label("https://example.invalid/", "zoo-link"), "zoo-link")

    def linked(*_):
        record("zoo-link", "activate")
        return True

    link.connect("activate-link", linked)
    expander = add(Gtk.Expander(label="zoo-expander"), "zoo-expander")
    expander.set_child(named(Gtk.Label(label="Expanded content"), "zoo-expander-content"))
    expander.connect("notify::expanded", lambda w, *_: record("zoo-expander", "expanded", w.get_expanded()))
    tabs = add(Gtk.Notebook(), "zoo-tabs")
    for name in ("zoo-tab-a", "zoo-tab-b"):
        tabs.append_page(named(Gtk.Box(), name), named(Gtk.Label(label=name), name))
    tabs.connect("switch-page", lambda w, p, i: record(("zoo-tab-a", "zoo-tab-b")[i], "page", ("zoo-tab-a", "zoo-tab-b")[i]))
    rows = add(Gtk.ListBox(), "zoo-list")
    rows.set_selection_mode(Gtk.SelectionMode.SINGLE)
    row_names = {}
    for i in range(1, 4):
        name = f"zoo-row-{i}"
        row = named(Gtk.ListBoxRow(), name)
        row.set_child(named(Gtk.Label(label=name), name + "-label"))
        rows.append(row)
        row_names[row] = name
    rows.connect("row-selected", lambda w, r: r is not None and record(row_names[r], "row", row_names[r]))
    disabled = add(Gtk.Button(label="zoo-disabled"), "zoo-disabled")
    disabled.set_sensitive(False)
    hidden = add(Gtk.Button(label="zoo-hidden"), "zoo-hidden")
    toolbar = add(Gtk.Box(), "zoo-toolbar")
    toolbar.append(named(Gtk.Button(label="zoo-toolbar-hidden"), "zoo-toolbar-hidden"))
    scroll = add(Gtk.ScrolledWindow(), "zoo-scroll")
    scroll.set_min_content_height(100)
    scroll.set_max_content_height(100)
    scroll.set_propagate_natural_height(True)
    tall = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)
    tall.set_size_request(-1, 2000)
    spacer = Gtk.Box()
    spacer.set_vexpand(True)
    tall.append(spacer)
    offscreen = named(Gtk.Button(label="zoo-offscreen"), "zoo-offscreen")
    offscreen.connect("clicked", lambda *_: record("zoo-offscreen", "activate"))
    tall.append(offscreen)
    scroll.set_child(tall)

    named(scroll.get_vscrollbar(), "zoo-scroll-vscroll")
    named(scroll.get_hscrollbar(), "zoo-scroll-hscroll")
    for adjustment, name in ((scroll.get_vadjustment(), "zoo-scroll-vscroll"),
                             (scroll.get_hadjustment(), "zoo-scroll-hscroll")):
        adjustment.connect("value-changed", lambda a, n=name: record(n, "changed", a.get_value()))

    def open_dialog():
        dialog = Gtk.Dialog(title="Zoo Dialog", transient_for=window, modal=True)
        dialogs.append(dialog)
        field = named(Gtk.Entry(), "zoo-dialog-entry")
        field.connect("changed", lambda w: record("zoo-dialog-entry", "changed", w.get_text()))
        dialog.get_content_area().append(field)
        named(dialog.add_button("Cancel", Gtk.ResponseType.CANCEL), "zoo-dialog-cancel")
        named(dialog.add_button("OK", Gtk.ResponseType.OK), "zoo-dialog-ok")

        def response(w, code):
            if code == Gtk.ResponseType.OK:
                record("zoo-dialog-ok", "activate")
            w.destroy()
            dialogs.remove(w)

        dialog.connect("response", response)
        dialog.present()

    def open_chooser():
        dialog = Gtk.FileChooserDialog(title="Zoo Save", transient_for=window,
                                       action=Gtk.FileChooserAction.SAVE, modal=True)
        dialogs.append(dialog)
        named(dialog.add_button("Cancel", Gtk.ResponseType.CANCEL), "zoo-save-cancel")
        named(dialog.add_button("Save", Gtk.ResponseType.ACCEPT), "zoo-save-ok")

        def response(w, code):
            if code == Gtk.ResponseType.ACCEPT:
                Path(w.get_file().get_path()).write_text("widget-zoo\n")
                record("zoo-open-chooser", "saved", w.get_file().get_path())
            w.destroy()
            dialogs.remove(w)

        dialog.connect("response", response)
        dialog.present()

    previous = initial_focus
    for name, callback in (("zoo-open-dialog", open_dialog),
                           ("zoo-open-chooser", open_chooser)):
        opener = button(name, callback)
        box.reorder_child_after(opener, previous)
        previous = opener

    def finish_reset():
        nonlocal resetting
        resetting = False
        Path(str(log) + ".reset").rename(Path(str(log) + ".reset-consumed"))
        record("zoo", "reset")
        return False

    def control():
        nonlocal resetting
        reset = Path(str(log) + ".reset")
        if reset.exists() and not resetting:
            resetting = True
            for dialog in dialogs:
                dialog.destroy()
            dialogs.clear()
            menu.popdown()
            combo_toggle = combo.get_first_child()
            if isinstance(combo_toggle, Gtk.ToggleButton):
                combo_toggle.set_active(False)
            for widget in (toggle, check, switch):
                widget.set_active(False)
            radio_a.set_active(True)
            combo.set_selected(0)
            spin.set_value(0)
            scale.set_value(0)
            entry.set_text("")
            password.set_text("")
            buffer.set_text("")
            link.set_visited(False)
            expander.set_expanded(False)
            tabs.set_current_page(0)
            rows.unselect_all()
            scroll.get_vadjustment().set_value(0)
            scroll.get_hadjustment().set_value(0)
            window.set_focus(initial_focus)
            GLib.idle_add(finish_reset)
        return True

    GLib.timeout_add(20, control)
    window.present()
    hidden.set_visible(False)
    toolbar.set_visible(False)
    loop.run()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
