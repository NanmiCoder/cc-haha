import unittest
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from runner import legs, verdict
from runner.product import Envelope
from runner.verdict import LegContext
from scenarios import headed_actions, lifecycle, menus, non_interference, observation, pointer, text_entry, wayland_input


class RestorationTests(unittest.TestCase):
    def test_typing_restores_the_original_document_and_reads_it_back(self):
        tier = SimpleNamespace(runtime_dir=Path("/private/test"))
        app = SimpleNamespace(windows=["w-editor"])
        for module, run, leg_id in (
            (headed_actions, headed_actions.type_text, "headed_actions.type_text"),
            (text_entry, text_entry.typed_text_reaches_document, "text_entry.typed_text_reaches_document")):
            for original in ("", "saved"):
                with self.subTest(leg=leg_id, original=original):
                    document = [original]
                    ctx = LegContext(tier, "headed", legs.leg_by_id(leg_id),
                                     member_reader=lambda _: frozenset())
                    def product(tier, argv, **kw):
                        if argv[0] == "type":
                            document[0] += argv[-1]
                        elif argv[0] == "clear":
                            document[0] = ""
                        return Envelope(True, {}, None, "{}", 0, argv)
                    with patch.object(lifecycle.apps, "launch", return_value=app), \
                        patch.object(lifecycle.apps, "stop"), \
                        patch.object(headed_actions, "ref_for", return_value="@s:e1"), \
                        patch.object(text_entry, "ref_for", return_value="@s:e1"), \
                        patch.object(headed_actions, "live_root", return_value=app), \
                        patch.object(text_entry, "live_root", return_value=app), \
                        patch.object(headed_actions, "longest_text", side_effect=lambda _: document[0]), \
                        patch.object(text_entry, "longest_text", side_effect=lambda _: document[0]), \
                        patch.object(lifecycle.atspi_raw, "poll", side_effect=lambda read, *a, **kw: read()), \
                        patch("runner.verdict.run_product", side_effect=product):
                        run(ctx)
                    self.assertEqual(verdict.evaluate(ctx), [])
                    self.assertEqual(document[0], original)

    def test_native_window_readers_resolve_opaque_ids_before_xprop(self):
        tier = SimpleNamespace(env={})
        for read in (lambda: pointer._xprop(tier, "w-calculator", "_GTK_FRAME_EXTENTS"),
                     lambda: lifecycle._wm_state(tier, "w-calculator")):
            with patch.object(lifecycle.x11, "xid", return_value="0x123"), \
                patch.object(lifecycle.subprocess, "run", return_value=SimpleNamespace(stdout="state")) as run:
                self.assertEqual(read(), "state")
                self.assertEqual(run.call_args.args[0][:3], ["xprop", "-id", "0x123"])

    def test_window_changes_restore_the_measured_geometry_and_state(self):
        tier = SimpleNamespace(runtime_dir=Path("/private/test"))
        app = SimpleNamespace(windows=["w-calculator"])
        for name in ("window_operation_delivery_reports",
                     "minimize_restore", "maximize_restore"):
            with self.subTest(leg=name):
                geometry = [(10, 20, 300, 400)]
                state = [""]
                ctx = LegContext(tier, "headless", legs.leg_by_id("lifecycle." + name),
                                 member_reader=lambda _: frozenset())
                def product(tier, argv, **kw):
                    if "w-missing" in argv:
                        return Envelope(False, None, {"code": "WINDOW_NOT_FOUND",
                            "disposition": {"delivery": "not_delivered"}}, "{}", 0, argv)
                    value = lambda key: int(argv[argv.index(key) + 1])
                    x, y, width, height = geometry[0]
                    if argv[0] == "resize-window":
                        geometry[0] = (x, y, value("--width"), value("--height"))
                    elif argv[0] == "move-window":
                        geometry[0] = (value("--x"), value("--y"), width, height)
                    elif argv[0] == "minimize":
                        state[0] = "_NET_WM_STATE_HIDDEN"
                    elif argv[0] == "maximize":
                        state[0] = "_NET_WM_STATE_MAXIMIZED_VERT, _NET_WM_STATE_MAXIMIZED_HORZ"
                    elif argv[0] == "restore":
                        state[0] = ""
                    return Envelope(True, {"disposition": {"delivery": "delivered_verified"},
                        "details": {"delivered_events": 1}, "steps": [{}]}, None, "{}", 0, argv)
                with patch.object(lifecycle.apps, "launch", return_value=app), \
                    patch.object(lifecycle.apps, "stop"), \
                    patch.object(lifecycle, "_geometry", side_effect=lambda *a: geometry[0]), \
                    patch.object(lifecycle, "_wm_state", side_effect=lambda *a: state[0]), \
                    patch.object(lifecycle.atspi_raw, "poll", side_effect=lambda read, *a, **kw: read()), \
                    patch("runner.verdict.run_product", side_effect=product):
                    getattr(lifecycle, name)(ctx)
                self.assertEqual(verdict.evaluate(ctx), [])
                self.assertEqual(geometry[0], (10, 20, 300, 400))
                self.assertEqual(state[0], "")

    def test_focus_compares_native_ids_and_reads_back_restoration(self):
        tier = SimpleNamespace(runtime_dir=Path("/private/test"))
        calculator = SimpleNamespace(windows=["w-calculator"])
        editor = SimpleNamespace(windows=["w-editor"])
        active = ["0x2"]
        def product(tier, argv, **kw):
            if argv[0] in ("focus-window", "click"):
                self.assertEqual(argv[-1], "w-calculator" if argv[0] == "focus-window" else "@s:e1")
                active[0] = "0x1"
            return Envelope(True, {}, None, "{}", 0, argv)
        def tool(tier, argv):
            self.assertEqual(argv, ["wmctrl", "-ia", "0x2"])
            active[0] = "0x2"
        cases = ((lifecycle.focus_window_active_reads, "lifecycle.focus_window_active_reads"),
                 (headed_actions.focus_reads_active_window, "headed_actions.focus_reads_active_window"))
        for run, leg_id in cases:
            with self.subTest(leg=leg_id):
                active[0] = "0x2"
                ctx = LegContext(tier, "headed", legs.leg_by_id(leg_id),
                                 member_reader=lambda _: frozenset())
                with patch.object(lifecycle.apps, "launch", side_effect=[calculator, editor]), \
                    patch.object(lifecycle.apps, "stop"), \
                    patch.object(headed_actions, "ref_for", return_value="@s:e1"), \
                    patch.object(lifecycle.x11, "xid", return_value="0x1"), \
                    patch.object(lifecycle.x11, "active_window", side_effect=lambda _: active[0]), \
                    patch.object(lifecycle.x11, "tool", side_effect=tool), \
                    patch.object(lifecycle.atspi_raw, "poll", side_effect=lambda read, *a, **kw: read()), \
                    patch("runner.verdict.run_product", side_effect=product):
                    run(ctx)
                self.assertEqual(verdict.evaluate(ctx), [])
                self.assertEqual(active[0], "0x2")


class SemanticRestorationTests(unittest.TestCase):
    def test_semantic_click_reads_display_and_restores_without_moving_focus_or_pointer(self):
        tier = SimpleNamespace(runtime_dir=Path("/private/test"))
        app = SimpleNamespace(windows=["w-calculator"])
        name = "active_window_unchanged_by_semantic_click"
        for drift, original in ((False, ""), (False, "0"), (True, "")):
            with self.subTest(leg=name, drift=drift, original=original):
                document, focus = [original], ["0x2"]
                ctx = LegContext(tier, "headless", legs.leg_by_id("non_interference." + name),
                                 member_reader=lambda _: frozenset())
                def product(tier, argv, **kw):
                    document[0] = "7"
                    if drift:
                        focus[0] = "0x1"
                    return Envelope(True, {}, None, "{}", 0, argv)
                with patch.object(non_interference.apps, "launch", return_value=app), \
                    patch.object(non_interference.apps, "stop"), \
                    patch.object(non_interference, "live_root", return_value=app), \
                    patch.object(non_interference, "display", side_effect=lambda _: document[0]), \
                    patch.object(non_interference, "one", return_value="undo"), \
                    patch.object(non_interference, "activate", side_effect=lambda _: document.__setitem__(0, original)), \
                    patch.object(non_interference, "ref_for", return_value="@s:e1"), \
                    patch.object(non_interference.x11, "pointer", return_value=(10, 20)), \
                    patch.object(non_interference.x11, "active_window", side_effect=lambda _: focus[0]), \
                    patch("oracle.atspi_raw.poll", side_effect=lambda read, *a, **kw: read()), \
                    patch("runner.verdict.run_product", side_effect=product):
                    if drift:
                        with self.assertRaisesRegex(AssertionError, "pointer or focus"):
                            getattr(non_interference, name)(ctx)
                    else:
                        getattr(non_interference, name)(ctx)
                        self.assertEqual(verdict.evaluate(ctx), [])
                self.assertEqual(document[0], original)

    def test_wayland_paste_restores_document_and_clipboard_and_reaps_foreign_owner(self):
        tier = SimpleNamespace(runtime_dir=Path("/private/test"))
        app = SimpleNamespace(windows=["w-editor"])
        ctx = LegContext(tier, "headless", None,
                         member_reader=lambda _: frozenset())
        document, selection, owners = [""], [None], set()
        def foreign_set(tier, fmt, data):
            selection[0] = data
            owners.add(101)
            return 101
        def product(tier, argv, **kw):
            if argv[0] == "press":
                document[0] = selection[0].decode()
            elif argv[0] == "clear":
                document[0] = ""
            elif argv[0] == "clipboard-clear":
                selection[0] = None
            return Envelope(True, {}, None, "{}", 0, argv)
        with patch.object(wayland_input, "_editor", return_value=(app, app, "@s:e1")), \
            patch.object(wayland_input, "_window_id", return_value="w-editor"), \
            patch.object(wayland_input, "document_text", side_effect=lambda _: document[0]), \
            patch.object(wayland_input, "app_root", return_value=app), \
            patch.object(wayland_input, "stop"), \
            patch.object(wayland_input, "poll", side_effect=lambda read, *a, **kw: read()), \
            patch.object(lifecycle.atspi_raw, "poll", side_effect=lambda read, *a, **kw: read()), \
            patch.object(wayland_input.clipboard, "foreign_set", side_effect=foreign_set), \
            patch.object(wayland_input.clipboard, "foreign_get", side_effect=lambda *a: selection[0]), \
            patch.object(wayland_input.clipboard, "stop_owner", side_effect=owners.remove), \
            patch("runner.verdict.run_product", side_effect=product):
            wayland_input.clipboard_paste_into_app(ctx)
        self.assertEqual(verdict.evaluate(ctx), [])
        self.assertEqual((document[0], selection[0], owners), ("", None, set()))


class RegistryRestorationTests(unittest.TestCase):
    def test_stale_reference_waits_for_owner_unregistration_after_process_exit(self):
        tier = SimpleNamespace(runtime_dir=Path("/private/test"), display=None)
        app = SimpleNamespace(owner_names=[":1.8"])
        ctx = LegContext(tier, "headless", legs.leg_by_id("observation.stale_ref_after_app_killed"),
                         member_reader=lambda _: frozenset())
        stopped, reads = [False], [0]
        def registry(tier):
            if stopped[0]:
                reads[0] += 1
                if reads[0] < 3:
                    return [SimpleNamespace(bus=":1.8")]
            return []
        response = Envelope(False, None, {"code": "STALE_REF"}, "{}", 0, [])
        with patch.object(observation.apps, "launch", return_value=app), \
            patch.object(observation.apps, "stop", side_effect=lambda _: stopped.__setitem__(0, True)), \
            patch.object(observation.raw, "registry", side_effect=registry), \
            patch.object(observation, "members", return_value=[]), \
            patch.object(observation, "ref", return_value="@s:e1"), \
            patch("runner.verdict.run_product", return_value=response):
            observation.stale_ref_after_app_killed(ctx)
        self.assertGreaterEqual(reads[0], 3)
        self.assertEqual(verdict.evaluate(ctx), [])


class MenuRestorationTests(unittest.TestCase):
    def test_registered_preferences_click_requires_an_independent_unique_dialog(self):
        for dialog_count, owns_focus in ((0, True), (1, True), (2, True), (1, False)):
            with self.subTest(dialog_count=dialog_count, owns_focus=owns_focus):
                tier = SimpleNamespace(runtime_dir=Path("/private/test"), display=":1")
                leg_id = "menus.preferences_find_ref"
                ctx = LegContext(tier, "headless", legs.leg_by_id(leg_id),
                                 member_reader=lambda _: frozenset())
                app = SimpleNamespace(windows=["w-calculator"], owner_names=[":1.8"])
                dialogs, stopped, active = [], [], ["0x1"]
                dialog = SimpleNamespace(name="Preferences", role=16, states={"SHOWING"},
                                         bus=":1.8", path="/dialog")
                owner = SimpleNamespace(bus=":1.8", walk=lambda: list(dialogs))

                @contextmanager
                def managed(*args):
                    try:
                        yield app
                    finally:
                        dialogs.clear()
                        stopped.append(True)

                def product(tier, argv, **kw):
                    data = {}
                    if argv[0] == "snapshot":
                        data = {"complete": True, "tree": {
                            "name": "Preferences", "ref_id": "@menu:e3"}}
                    elif argv[0] == "find":
                        name = argv[argv.index("--name") + 1]
                        if name == "Main Menu":
                            self.assertEqual(argv[argv.index("--role") + 1], "switch")
                        data = {"matches": [{"ref_id": "@opener:e2" if name == "Main Menu"
                                             else "@found:e4"}]}
                    elif argv[0] == "click" and argv[1] != "@opener:e2":
                        self.assertEqual(argv[1], "@found:e4")
                        dialogs.extend([dialog] * dialog_count)
                        active[0] = "0x2"
                        data = {"steps": [{"mechanism": "semantic_api"}]}
                    return Envelope(True, data, None, "{}", 0, argv)

                with patch.object(menus, "managed", managed), \
                    patch.object(menus, "registry", return_value=[owner]), \
                    patch.object(menus.x11, "pointer", return_value=(0, 0)), \
                    patch.object(menus.x11, "active_window", side_effect=lambda _: active[0]), \
                    patch.object(menus.x11, "product_window",
                                 return_value="w-1.8-dialog" if owns_focus else "w-foreign"), \
                    patch.object(lifecycle.atspi_raw, "poll", side_effect=lambda read, *a, **kw: read()), \
                    patch("runner.verdict.run_product", side_effect=product):
                    run = legs.implementations()[leg_id]
                    if dialog_count == 1 and owns_focus:
                        run(ctx)
                        self.assertEqual(verdict.evaluate(ctx), [])
                        self.assertEqual(ctx.reads["atspi.preferences_dialogs"]["after"], [1])
                    else:
                        message = ("oracle never reached 1" if dialog_count != 1 else
                                   "other than the new Preferences dialog")
                        with self.assertRaisesRegex(AssertionError, message):
                            run(ctx)
                self.assertEqual(stopped, [True])

    def test_wait_menu_reads_actual_popup_state_and_restores_each_transition(self):
        for name in ("wait_menu_opens_calculator", "wait_menu_closes_calculator",
                     "wait_menu_already_open", "hidden_bar_timeout_message"):
            with self.subTest(leg=name):
                tier = SimpleNamespace(runtime_dir=Path("/private/test"))
                contract = legs.Leg("menus." + name, "Observe and restore popup state",
                                    "fake popup", ("x11-openbox",), ("headless",),
                                    ("atspi",), "pass")
                ctx = LegContext(tier, "headless", contract,
                                 member_reader=lambda _: frozenset())
                visible = [False]
                class Item:
                    @property
                    def states(self):
                        return {"SHOWING"} if visible[0] else set()
                class Toggle:
                    role = 62
                    def do_action(self, action):
                        visible[0] = not visible[0]
                        return True
                class Outer:
                    role = 43
                    def do_action(self, action):
                        raise AssertionError("outer menu button is not an actionable toggle")
                def find(**kw):
                    return [Item()] if kw.get("role") == 35 else [Outer(), Toggle()]
                root = SimpleNamespace(find=find)
                def product(tier, argv, **kw):
                    if argv[argv.index("--app") + 1] == "Terminal":
                        return Envelope(False, None, {"code": "APP_NOT_FOUND"}, "ambiguous desktop alias", 0, argv)
                    if name == "hidden_bar_timeout_message":
                        details = {"kind": "wait_timeout", "predicate": "menu", "timeout_ms": 1500}
                        return Envelope(False, None, {"code": "TIMEOUT", "message": "No menu opened before the deadline",
                                                      "details": details}, "{}", 1500, argv)
                    return Envelope(True, {"found": True}, None, "{}", 5, argv)
                with patch.object(menus, "launch", return_value=object()), \
                    patch.object(menus, "stop"), \
                    patch.object(menus, "app_root", return_value=root), \
                    patch.object(lifecycle.atspi_raw, "poll", side_effect=lambda read, *a, **kw: read()), \
                    patch("runner.verdict.run_product", side_effect=product):
                    getattr(menus, name)(ctx)
                self.assertEqual(verdict.evaluate(ctx), [])
                reads = ctx.reads["atspi.menu_visible"]
                self.assertEqual(reads["before"], reads["restored"])
