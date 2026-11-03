import contextlib
import json
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))

from runner.product import Envelope
from runner.apps import OwnedApp
from runner import legs
from runner.verdict import LegContext
from scenarios import gaps_actions, gaps_capture, gaps_events, gaps_mutter


def context():
    return LegContext(SimpleNamespace(display=":100"), "headless",
                      member_reader=lambda _: frozenset())


def envelope(data):
    return Envelope(True, data, None, json.dumps(data), 1, [])


class GapScenarioTests(unittest.TestCase):
    def test_maximized_oracle_requires_both_axes_and_handles_comma_delimited_atoms(self):
        for atoms, expected in (("_NET_WM_STATE_MAXIMIZED_VERT, _NET_WM_STATE_MAXIMIZED_HORZ, _NET_WM_STATE_FOCUSED", True),
                                ("_NET_WM_STATE_MAXIMIZED_VERT", False), ("_NET_WM_STATE_FOCUSED", False)):
            with self.subTest(atoms=atoms), patch.object(gaps_mutter.lifecycle, "_wm_state", return_value=atoms):
                self.assertEqual(gaps_mutter.maximized_state(context(), "window"), expected)

    def test_wayland_clipboard_refusal_requires_the_seat_reason_and_no_foreign_offers(self):
        for ok, reason, offers, foreign_error in ((False, "no_keyboard_seat", b"", b"No selection"), (True, None, b"", b"No selection"),
                                   (False, "wrong_guard", b"", b"No selection"), (False, "no_keyboard_seat", b"text/plain\n", b"No selection"),
                                   (False, "no_keyboard_seat", b"", b"No seat keyboard")):
            with self.subTest(ok=ok, reason=reason, offers=offers):
                ctx = context()
                ctx.tier.runtime_dir, ctx.tier.env = Path("/private/test"), {}
                error = {"code": "ACTION_FAILED", "details": {"reason": reason},
                         "disposition": {"delivery": "not_delivered"}}
                reply = Envelope(ok, None, error, "refusal", 1, [])
                outputs = [(1, b"", foreign_error), (0, offers, b""), (1, b"", b"No selection")]
                with patch.object(gaps_capture.foreign_clipboard, "_run", side_effect=outputs), \
                    patch.object(gaps_capture.proc, "members", return_value=[]), \
                    patch.object(ctx, "product", return_value=reply):
                    if not ok and reason == "no_keyboard_seat" and not offers and foreign_error == b"No selection":
                        gaps_capture.clipboard_refusal(ctx, ["clipboard-clear"])
                    else:
                        with self.assertRaises(AssertionError):
                            gaps_capture.clipboard_refusal(ctx, ["clipboard-clear"])

    def test_terminated_event_requires_process_exit_even_after_the_registry_owner_disappears(self):
        for exits in (False, True):
            with self.subTest(exits=exits):
                ctx = context()
                ctx.tier.runtime_dir = Path("/private/test")
                state = {"registry": True, "old_alive": True, "replacement": False}
                @contextlib.contextmanager
                def managed(ctx, name):
                    if not state["registry"]:
                        state.update(registry=True, replacement=True)
                    yield SimpleNamespace(pid=123)
                def event(*a):
                    state.update(registry=False, old_alive=not exits)
                    return {"pid": 123}
                def members(*a):
                    return ([(123, 1, "gnome-calculato")] if state["old_alive"] else []) + (
                        [(124, 1, "gnome-calculato")] if state["replacement"] else [])
                with patch.object(gaps_events, "managed", side_effect=managed), \
                    patch.object(gaps_events, "inventory", side_effect=lambda *a: [("Calculator", 1)] if state["registry"] else []), \
                    patch.object(gaps_events.proc, "members", side_effect=members), \
                    patch.object(gaps_events, "batch_wait", side_effect=event), \
                    patch.object(gaps_events.raw, "poll", side_effect=lambda predicate, *a, **kw: predicate()):
                    if exits:
                        gaps_events.close_transition(ctx, "app-terminated", True)
                        self.assertEqual(ctx.reads["proc.calculator_count"]["after"], [0])
                    else:
                        with self.assertRaises(AssertionError):
                            gaps_events.close_transition(ctx, "app-terminated", True)

    def test_window_close_batch_uses_the_public_ref_id_field_and_preserves_the_seed_frame(self):
        ctx, frames = context(), ["seed"]
        app = OwnedApp("Text Editor", 123, 1, [":1.2"], ["seed"], ":100")
        def launch(*args):
            frames.append("added")
            return app
        def product(argv):
            action = json.loads(argv[1])[0]
            self.assertEqual(action, {"command": "click", "args": {"ref_id": "@s:e2"}})
            frames.remove("added")
            return envelope({"results": [{"ok": True}, {"ok": True, "data": {
                "event": {"kind": "window_closed", "window_id": "added", "pid": 123}}}]})
        with patch.object(gaps_events, "managed", return_value=contextlib.nullcontext(app)), \
            patch.object(gaps_events.apps, "launch", side_effect=launch), \
            patch.object(gaps_events, "_window_ids", side_effect=lambda tier: list(frames)), \
            patch.object(gaps_events, "_close_added_windows", side_effect=lambda *a: frames.__setitem__(slice(None), ["seed"])), \
            patch.object(gaps_events, "ref", return_value="@s:e2"), \
            patch.object(gaps_events.raw, "poll", side_effect=lambda predicate, *a, **kw: predicate()), \
            patch.object(ctx, "product", side_effect=product):
            gaps_events.window_transition(ctx, "window-closed", True)
        self.assertEqual(frames, ["seed"])
        self.assertEqual(ctx.reads["atspi.editor_windows"]["before"], [(2, True)])
        self.assertEqual(ctx.reads["atspi.editor_windows"]["after"], [(1, True)])
        self.assertEqual(ctx.reads["atspi.editor_windows"]["restored"], [(2, True)])

    def test_quiet_event_requires_an_observed_baseline_for_the_requested_token(self):
        good = {"kind": "wait_timeout", "event": "window-opened", "baseline_counts": {"windows": 1, "apps": 1, "surfaces": 0}}
        for details in (good, {}, dict(good, baseline_counts=None), dict(good, event="app-launched"),
                        dict(good, baseline_counts={}), dict(good, baseline_counts={"windows": None}),
                        dict(good, baseline_counts={"windows": 1, "apps": True, "surfaces": 0})):
            with self.subTest(details=details):
                ctx = context()
                response = Envelope(False, None, {"code": "TIMEOUT", "details": details}, "timeout", 1500, [])
                with patch.object(gaps_events, "managed", return_value=contextlib.nullcontext(object())), \
                    patch.object(gaps_events, "inventory", return_value=[("Calculator", 1)]), \
                    patch.object(ctx, "product", return_value=response):
                    if details is good:
                        gaps_events.quiet(ctx, "window-opened", True)
                        self.assertEqual(ctx.reads["atspi.inventory"]["before"], ctx.reads["atspi.inventory"]["restored"])
                    else:
                        with self.assertRaisesRegex(AssertionError, "without an observed baseline"):
                            gaps_events.quiet(ctx, "window-opened", True)

    def test_disabled_action_rejects_ignored_timeout_flags_and_changed_text(self):
        for timeout, elapsed, mutated, valid in ((None, 5000, False, True), (2000, 2000, False, True),
                                                  (100, 100, False, True), (0, 0, False, True),
                                                  (None, 100, False, False), (2000, 5000, False, False),
                                                  (100, 5000, False, False), (0, 5000, False, False),
                                                  (0, 0, True, False)):
            with self.subTest(timeout=timeout, elapsed=elapsed, mutated=mutated):
                ctx, text = context(), [""]
                undo = SimpleNamespace(states=frozenset())
                def product(argv):
                    if mutated:
                        text[0] = "wrong effect"
                    error = {"code": "TIMEOUT", "details": {"kind": "actionability_timeout"}}
                    if timeout == 0:
                        error = {"code": "ACTION_FAILED", "details": {"checks": [
                            {"check": "enabled", "status": "fail"}]}, "disposition": {"delivery": "not_delivered"}}
                    return Envelope(False, None, error, "refusal", elapsed, argv)
                with patch.object(gaps_actions, "managed", return_value=contextlib.nullcontext(object())), \
                    patch.object(gaps_actions, "root", return_value=object()), \
                    patch.object(gaps_actions, "one", return_value=undo), \
                    patch.object(gaps_actions, "ref", return_value="@snapshot:e1"), \
                    patch.object(gaps_actions, "display", side_effect=lambda tree: text[0]), \
                    patch.object(ctx, "product", side_effect=product):
                    if valid:
                        gaps_actions.disabled_timeout(ctx, timeout)
                    else:
                        with self.assertRaises(AssertionError):
                            gaps_actions.disabled_timeout(ctx, timeout)

    def test_seeded_wait_rejects_wrong_token_and_failed_batch_entries(self):
        good = [{"ok": True}, {"ok": True, "data": {
            "event": {"kind": "focus_changed_window", "window_id": "target"}}}]
        ctx = context()
        with patch.object(ctx, "product", return_value=envelope({"results": good})):
            self.assertEqual(gaps_events.batch_wait(ctx, "focus-changed", True, {})["window_id"], "target")
        for bad in ([{"ok": True}], [{"ok": False}, good[1]],
                    [good[0], {"ok": True, "data": {"event": {"kind": "window_opened"}}}]):
            with self.subTest(results=bad), patch.object(ctx, "product", return_value=envelope({"results": bad})):
                with self.assertRaises(AssertionError):
                    gaps_events.batch_wait(ctx, "focus-changed", False, {})

    def test_focus_success_requires_the_real_target_and_restores_the_original_window(self):
        app = SimpleNamespace(windows=["calculator"])
        other = SimpleNamespace(windows=["editor"])
        for actual_effect, reported_target in ((True, "calculator"), (False, "calculator"), (True, "foreign")):
            with self.subTest(effect=actual_effect, reported_target=reported_target):
                ctx, active = context(), ["editor"]
                def product(argv):
                    if actual_effect:
                        active[0] = "calculator"
                    return envelope({"results": [{"ok": True}, {"ok": True, "data": {
                        "event": {"kind": "focus_changed_window", "window_id": reported_target}}}]})
                def restore(tier, window):
                    active[0] = window
                    return active[0]
                with patch.object(gaps_events, "managed", side_effect=[contextlib.nullcontext(app), contextlib.nullcontext(other)]), \
                    patch.object(gaps_events.x11, "xid", side_effect=lambda tier, window: window), \
                    patch.object(gaps_events.x11, "active_window", side_effect=lambda tier: active[0]), \
                    patch.object(gaps_events.x11, "restore_active", side_effect=restore), \
                    patch.object(gaps_events.raw, "poll", side_effect=lambda predicate, *a, **kw: predicate()), \
                    patch.object(ctx, "product", side_effect=product):
                    if actual_effect and reported_target == "calculator":
                        gaps_events.focus_transition(ctx, True)
                        self.assertEqual(ctx.reads["x11.focus"]["after"], ["calculator"])
                    else:
                        with self.assertRaises(AssertionError):
                            gaps_events.focus_transition(ctx, True)
                self.assertEqual(active[0], "editor")
                self.assertEqual(ctx.reads["x11.focus"]["restored"], ["editor"])

    def test_background_write_rejects_stolen_focus_and_restores_the_setting(self):
        app, other = SimpleNamespace(windows=["settings"]), SimpleNamespace(windows=["editor"])
        for steals_focus in (False, True):
            with self.subTest(steals_focus=steals_focus):
                ctx, state = context(), {"value": "0.0", "active": "editor"}
                def product(argv):
                    state["value"] = argv[-1]
                    if steals_focus:
                        state["active"] = "settings"
                    return envelope({})
                def restore(tier, window):
                    state["active"] = window
                    return window
                with patch.object(gaps_actions, "managed", side_effect=[contextlib.nullcontext(app), contextlib.nullcontext(other)]), \
                    patch.object(gaps_actions, "ref", return_value="@snapshot:e1"), \
                    patch.object(gaps_actions.x11, "xid", return_value="editor"), \
                    patch.object(gaps_actions.x11, "active_window", side_effect=lambda tier: state["active"]), \
                    patch.object(gaps_actions.x11, "restore_active", side_effect=restore), \
                    patch.object(gaps_actions.x11, "pointer", return_value=(1, 2)), \
                    patch.object(gaps_actions.gsettings, "get", side_effect=lambda *a: state["value"]), \
                    patch.object(gaps_actions.gsettings, "set", side_effect=lambda *a: state.update(value=a[-1])), \
                    patch("runner.helper.raw.poll", side_effect=lambda predicate, *a, **kw: predicate()), \
                    patch.object(ctx, "product", side_effect=product):
                    if steals_focus:
                        with self.assertRaisesRegex(AssertionError, "stole focus"):
                            gaps_actions.value_write_preserves_active_window(ctx)
                    else:
                        gaps_actions.value_write_preserves_active_window(ctx)
                self.assertEqual(state, {"value": "0.0", "active": "editor"})

    def test_mutter_move_requires_changed_geometry_even_when_delivery_claims_success(self):
        for effect in (False, True):
            with self.subTest(effect=effect):
                ctx, geometry = context(), [(10, 20, 300, 400)]
                initial = geometry[0]
                def product(argv):
                    if effect:
                        geometry[0] = (40, 50, 300, 400)
                    return envelope({"disposition": {"delivery": "delivered_unverified"}})
                def restore(ctx, window, before):
                    geometry[0] = before
                    ctx.restored("x11.geometry", geometry[0])
                with patch.object(gaps_mutter, "managed", return_value=contextlib.nullcontext(SimpleNamespace(windows=["window"]))), \
                    patch.object(gaps_mutter.lifecycle, "_geometry", side_effect=lambda *a: geometry[0]), \
                    patch.object(gaps_mutter.lifecycle, "_restore_geometry", side_effect=restore), \
                    patch("runner.helper.raw.poll", side_effect=lambda predicate, *a, **kw: predicate()), \
                    patch.object(ctx, "product", side_effect=product):
                    if effect:
                        gaps_mutter.geometry_operation(ctx, "move-window")
                    else:
                        with self.assertRaises(AssertionError):
                            gaps_mutter.geometry_operation(ctx, "move-window")
                self.assertEqual(geometry[0], initial)
                self.assertEqual(ctx.reads["x11.geometry"]["restored"], [initial])
