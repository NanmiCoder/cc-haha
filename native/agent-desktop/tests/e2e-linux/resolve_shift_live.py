"""Run by name inside scripts/private-session.sh --wm with AGENT_DESKTOP_E2E_BIN."""

import json
import os
from pathlib import Path
import subprocess
import sys
import unittest

import gi

gi.require_version("Atspi", "2.0")
from gi.repository import Atspi, GLib


def fixture(reparent=False):
    gi.require_version("Gtk", "4.0")
    from gi.repository import Gtk

    def activate(app):
        window = Gtk.ApplicationWindow(application=app, title="Shifted siblings")
        column = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)
        counts = [0, 0, 0]
        status = Gtk.Label(label="counts:0:0:0")

        def clicked(_button, index):
            counts[index] += 1
            status.set_label("counts:" + ":".join(map(str, counts)))

        other = Gtk.Button(label="Remove other")
        saves = []

        def rearrange(button):
            column.remove(button)
            if reparent:
                column.remove(saves[0])
                wrapper = Gtk.Frame()
                wrapper.set_child(saves[0])
                column.append(wrapper)

        other.connect("clicked", rearrange)
        column.append(other)
        for index in range(2):
            button = Gtk.Button(label="Save")
            button.connect("clicked", clicked, index)
            column.append(button)
            saves.append(button)
        barrier = Gtk.Button(label="Barrier")
        barrier.connect("clicked", clicked, 2)
        column.append(barrier)
        column.append(status)
        window.set_child(column)
        window.present()

    app = Gtk.Application(application_id="org.agentdesktop.ResolveShift")
    app.connect("activate", activate)
    app.run([])


def walk(node):
    node.clear_cache()
    yield node
    for index in range(node.get_child_count()):
        child = node.get_child_at_index(index)
        if child is not None:
            yield from walk(child)


def wait_for(read, message):
    loop = GLib.MainLoop()
    result = []
    failure = []

    def check():
        try:
            value = read()
            if value:
                result.append(value)
                loop.quit()
                return False
        except GLib.Error as error:
            failure[:] = [str(error)]
        return True

    def expired():
        loop.quit()
        return False

    poll = GLib.timeout_add(50, check)
    timeout = GLib.timeout_add_seconds(15, expired)
    try:
        loop.run()
    finally:
        if result:
            GLib.source_remove(timeout)
        else:
            GLib.source_remove(poll)
    if not result:
        raise AssertionError(f"{message}: {failure}")
    return result[0]


class ResolveShiftLive(unittest.TestCase):
    def test_old_ref_refuses_shifted_twin_without_firing_either_button(self):
        self.assert_old_ref_refuses(False)

    def test_old_ref_refuses_reparented_twin_without_firing_either_button(self):
        self.assert_old_ref_refuses(True)

    def assert_old_ref_refuses(self, reparent):
        self.assertIn("AGENT_DESKTOP_PRIVATE_SESSION", os.environ)
        self.assertNotIn(os.environ["DISPLAY"], (":0", ":1", ":99"))
        binary = os.environ["AGENT_DESKTOP_E2E_BIN"]
        mode = "--fixture-depth" if reparent else "--fixture"
        with subprocess.Popen([sys.executable, str(Path(__file__).resolve()), mode]) as app:
            try:
                Atspi.init()
                Atspi.set_timeout(1000, 1000)

                def nodes():
                    desktop = Atspi.get_desktop(0)
                    for index in range(desktop.get_child_count()):
                        candidate = desktop.get_child_at_index(index)
                        if candidate.get_process_id() == app.pid:
                            candidate.clear_cache()
                            return list(walk(candidate))
                    return []

                def buttons(name):
                    return [node for node in nodes() if node.get_role() == Atspi.Role.PUSH_BUTTON
                            and node.get_name() == name]

                wait_for(lambda: len(buttons("Save")) == 2 and buttons("Remove other"),
                         "GTK4 exposes the original three siblings")

                def product(*args):
                    completed = subprocess.run([binary, *args], capture_output=True, text=True,
                                               timeout=30, check=False)
                    return json.loads(completed.stdout)

                windows = product("list-windows")
                self.assertTrue(windows["ok"], windows)
                window = next(window for window in windows["data"] if window["pid"] == app.pid)
                snapshot = product("snapshot", "--window-id", window["id"],
                                   "--timeout-ms", "15000")
                self.assertTrue(snapshot["ok"], snapshot)

                def tree_nodes(node):
                    yield node
                    for child in node.get("children", []):
                        yield from tree_nodes(child)

                saves = [node for node in tree_nodes(snapshot["data"]["tree"])
                         if node.get("name") == "Save" and node.get("role") == "button"]
                self.assertEqual(len(saves), 2, snapshot)
                old_ref = saves[0]["ref_id"]
                refmap_path = (Path(os.environ["AGENT_DESKTOP_HOME"]) / "snapshots" /
                               snapshot["data"]["snapshot_id"] / "refmap.json")
                refmap = json.loads(refmap_path.read_text())
                entry = refmap["inner"]["@" + old_ref.split(":")[-1]]
                self.assertIsNone(entry.get("bounds"), entry)
                self.assertIsNone(entry.get("retained_object"), entry)
                self.assertIsNone(entry.get("native_id"), entry)
                self.assertTrue(Atspi.Action.do_action(buttons("Remove other")[0], 0))
                wait_for(lambda: not buttons("Remove other") and len(buttons("Save")) == 2,
                         "the preceding sibling leaves the independent AT-SPI tree")
                if reparent:
                    def depth(node):
                        count = 0
                        while node.get_role() != Atspi.Role.FRAME:
                            node = node.get_parent()
                            count += 1
                        return count

                    stored_depth = len(entry["path"])
                    wait_for(lambda: sorted(depth(node) for node in buttons("Save")) ==
                             [stored_depth, stored_depth + 1],
                             "the original moves below a wrapper; its twin stays at the old depth")

                outcome = product("click", old_ref, "--timeout-ms", "2000")
                self.assertTrue(Atspi.Action.do_action(buttons("Barrier")[0], 0))
                status = wait_for(
                    lambda: next((node.get_name() for node in nodes()
                                  if node.get_role() == Atspi.Role.LABEL
                                  and node.get_name().startswith("counts:")
                                  and node.get_name().endswith(":1")), None),
                    "the independent AT-SPI barrier observes all prior actions")
                self.assertEqual(status, "counts:0:0:1", outcome)
                self.assertFalse(outcome["ok"], outcome)
                self.assertEqual(outcome["error"]["code"], "AMBIGUOUS_TARGET", outcome)
                print(f"live proof: {old_ref} -> AMBIGUOUS_TARGET; AT-SPI {status}")
            finally:
                app.terminate()


if __name__ == "__main__":
    if sys.argv[1:] in (["--fixture"], ["--fixture-depth"]):
        fixture(sys.argv[1] == "--fixture-depth")
    else:
        unittest.main()
