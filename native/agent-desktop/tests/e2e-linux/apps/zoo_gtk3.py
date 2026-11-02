"""GTK3 widget zoo with independently observable effects."""

import json
import os
import sys
import time
from pathlib import Path

os.environ["GTK_USE_PORTAL"] = "0"
import gi

gi.require_version("Gtk", "3.0")
from gi.repository import GLib, Gtk


def main(argv):
    if len(argv) != 1:
        raise ValueError("expected the JSON-lines log path")
    log = Path(argv[0])
    GLib.set_prgname("zoo_gtk3.py")
    GLib.set_application_name("Zoo GTK3")
    resetting = False
    dialogs = []
    window = Gtk.Window(title="Zoo GTK3")
    window.set_default_size(600, 900)
    box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=3)
    window.add(box)

    def named(widget, name):
        widget.get_accessible().set_name(name)
        return widget

    def record(name, event, value=None):
        if not resetting:
            with log.open("a") as stream:
                stream.write(json.dumps(dict(widget=name, event=event, value=value,
                                             at=time.monotonic())) + "\n")
                stream.flush()

    window.connect("destroy", lambda *_: record("zoo", "closed") or Gtk.main_quit())

    def add(widget, name):
        named(widget, name)
        box.pack_start(widget, False, False, 0)
        return widget

    def button(name, callback):
        widget = add(Gtk.Button(label=name), name)
        widget.connect("clicked", lambda *_: callback())
        return widget

    initial_focus = button("zoo-button", lambda: record("zoo-button", "activate"))
    toggle = add(Gtk.ToggleButton(label="zoo-toggle"), "zoo-toggle")
    check = add(Gtk.CheckButton(label="zoo-check"), "zoo-check")
    radio_a = add(Gtk.RadioButton.new_with_label_from_widget(None, "zoo-radio-a"), "zoo-radio-a")
    radio_b = add(Gtk.RadioButton.new_with_label_from_widget(radio_a, "zoo-radio-b"), "zoo-radio-b")
    radio_a.set_active(True)
    for widget, name in ((toggle, "zoo-toggle"), (check, "zoo-check")):
        widget.connect("toggled", lambda w, n=name: record(n, "toggled", w.get_active()))
    for widget, name in ((radio_a, "zoo-radio-a"), (radio_b, "zoo-radio-b")):
        widget.connect("toggled", lambda w, n=name: w.get_active() and record(n, "selected", n))
    switch = add(Gtk.Switch(), "zoo-switch")
    switch.connect("notify::active", lambda w, *_: record("zoo-switch", "toggled", w.get_active()))
    combo = add(Gtk.ComboBoxText(), "zoo-combo")
    for text in ("Alpha", "Bravo", "Charlie"):
        combo.append_text(text)
    combo.set_active(0)
    combo.connect("changed", lambda w: record("zoo-combo", "changed", w.get_active_text()))
    spin = add(Gtk.SpinButton.new_with_range(0, 10, 1), "zoo-spin")
    scale = add(Gtk.Scale.new_with_range(Gtk.Orientation.HORIZONTAL, 0, 100, 1), "zoo-scale")
    for widget, name in ((spin, "zoo-spin"), (scale, "zoo-scale")):
        widget.connect("value-changed", lambda w, n=name: record(n, "changed", w.get_value()))
    entry = add(Gtk.Entry(), "zoo-entry")
    password = add(Gtk.Entry(), "zoo-password")
    password.set_visibility(False)
    for widget in (entry, password):
        widget.connect("activate", lambda w: w.set_text("activated"))
    spin.connect("activate", lambda w: w.set_value(7))
    entry.connect("changed", lambda w: record("zoo-entry", "changed", w.get_text()))
    password.connect("changed", lambda w: record("zoo-password", "changed", len(w.get_text())))
    for widget, name in ((entry, "zoo-entry"), (password, "zoo-password"),
                         (spin, "zoo-spin")):
        widget.connect("notify::has-focus",
                       lambda w, _, n=name: w.has_focus() and record(n, "focus", True))
    text = add(Gtk.TextView(), "zoo-text")
    text.set_size_request(-1, 60)
    buffer = text.get_buffer()
    buffer.connect("changed", lambda b: record("zoo-text", "changed", b.get_text(*b.get_bounds(), True)))
    menu_button = add(Gtk.MenuButton(label="zoo-menubutton"), "zoo-menubutton")
    menu = Gtk.Menu()
    item = named(Gtk.MenuItem(label="zoo-menu-item"), "zoo-menu-item")
    item.connect("activate", lambda *_: record("zoo-menu-item", "activate"))
    menu.append(item)
    menu.show_all()
    menu_button.set_popup(menu)
    link = add(Gtk.LinkButton.new_with_label("https://example.invalid/", "zoo-link"), "zoo-link")

    def linked(*_):
        record("zoo-link", "activate")
        return True

    link.connect("activate-link", linked)
    expander = add(Gtk.Expander(label="zoo-expander"), "zoo-expander")
    expander.add(named(Gtk.Label(label="Expanded content"), "zoo-expander-content"))
    expander.connect("notify::expanded", lambda w, *_: record("zoo-expander", "expanded", w.get_expanded()))
    tabs = add(Gtk.Notebook(), "zoo-tabs")
    for name in ("zoo-tab-a", "zoo-tab-b"):
        page = named(Gtk.Box(), name)
        tabs.append_page(page, named(Gtk.Label(label=name), name))
    tabs.connect("switch-page", lambda w, p, i: record(("zoo-tab-a", "zoo-tab-b")[i], "page", ("zoo-tab-a", "zoo-tab-b")[i]))
    rows = add(Gtk.ListBox(), "zoo-list")
    rows.set_selection_mode(Gtk.SelectionMode.SINGLE)
    for i in range(1, 4):
        name = f"zoo-row-{i}"
        row = named(Gtk.ListBoxRow(), name)
        row.add(named(Gtk.Label(label=name), name + "-label"))
        rows.add(row)
    rows.connect("row-selected", lambda w, r: r is not None and record(r.get_accessible().get_name(), "row", r.get_accessible().get_name()))
    disabled = add(Gtk.Button(label="zoo-disabled"), "zoo-disabled")
    disabled.set_sensitive(False)
    hidden = add(Gtk.Button(label="zoo-hidden"), "zoo-hidden")
    toolbar = add(Gtk.Toolbar(), "zoo-toolbar")
    tool_item = Gtk.ToolItem()
    tool_item.add(named(Gtk.Button(label="zoo-toolbar-hidden"), "zoo-toolbar-hidden"))
    toolbar.insert(tool_item, -1)
    scroll = add(Gtk.ScrolledWindow(), "zoo-scroll")
    scroll.set_size_request(-1, 100)
    tall = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)
    tall.set_size_request(-1, 2000)
    offscreen = named(Gtk.Button(label="zoo-offscreen"), "zoo-offscreen")
    offscreen.connect("clicked", lambda *_: record("zoo-offscreen", "activate"))
    tall.pack_end(offscreen, False, False, 0)
    scroll.add(tall)

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
        dialog.get_content_area().add(field)
        named(dialog.add_button("Cancel", Gtk.ResponseType.CANCEL), "zoo-dialog-cancel")
        named(dialog.add_button("OK", Gtk.ResponseType.OK), "zoo-dialog-ok")

        def response(w, code):
            if code == Gtk.ResponseType.OK:
                record("zoo-dialog-ok", "activate")
            w.destroy()
            dialogs.remove(w)

        dialog.connect("response", response)
        dialog.show_all()

    def open_chooser():
        dialog = Gtk.FileChooserDialog(title="Zoo Save", transient_for=window,
                                       action=Gtk.FileChooserAction.SAVE, modal=True)
        dialogs.append(dialog)
        named(dialog.add_button("Cancel", Gtk.ResponseType.CANCEL), "zoo-save-cancel")
        named(dialog.add_button("Save", Gtk.ResponseType.ACCEPT), "zoo-save-ok")

        def response(w, code):
            if code == Gtk.ResponseType.ACCEPT:
                Path(w.get_filename()).write_text("widget-zoo\n")
                record("zoo-open-chooser", "saved", w.get_filename())
            w.destroy()
            dialogs.remove(w)

        dialog.connect("response", response)
        dialog.show_all()

    for index, (name, callback) in enumerate(
            (("zoo-open-dialog", open_dialog), ("zoo-open-chooser", open_chooser)), start=1):
        box.reorder_child(button(name, callback), index)

    def finish_reset():
        nonlocal resetting
        window.set_focus(None)
        window.set_focus(initial_focus)
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
            menu_button.set_active(False)
            combo.popdown()
            for widget in (toggle, check, switch):
                widget.set_active(False)
            radio_a.set_active(True)
            combo.set_active(0)
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
            GLib.idle_add(finish_reset)
        return True

    GLib.timeout_add(20, control)
    window.show_all()
    hidden.hide()
    toolbar.set_visible(False)
    Gtk.main()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
