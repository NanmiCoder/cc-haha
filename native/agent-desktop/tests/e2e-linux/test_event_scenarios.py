import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from runner import legs, main, report, verdict
from runner.product import Envelope
from runner.verdict import LegContext
from scenarios import events


class EventScenarioTests(unittest.TestCase):
    def test_killed_target_requires_requested_kind_and_independent_identity(self):
        for unresolved in (False, True):
            for fault in (None, "kind", "identity", "timeout", "dead-owner"):
                with self.subTest(unresolved=unresolved, fault=fault):
                    tier = SimpleNamespace(runtime_dir=Path("/private/test"))
                    ctx = LegContext(tier, "headless", legs.leg_by_id("events.target_killed_mid_wait"),
                                     member_reader=lambda _: frozenset())
                    owners, pending, generation = ["gnome-text-editor"], [], [123, 99]
                    event = {"kind": "app_launched" if fault == "kind" else "window_closed"}
                    if unresolved:
                        event["app"] = "Calculator" if fault == "identity" else "Text Editor"
                    else:
                        event.update(pid=999 if fault == "identity" else 123, window_id="raw-frame")
                    def product(tier, argv, **kw):
                        pending.pop()()
                        if fault == "timeout":
                            return Envelope(False, None, {"code": "TIMEOUT"}, "timeout", 8000, argv)
                        return Envelope(True, {"event": event, "target_unresolved": unresolved},
                                        None, str(event), 1, argv)
                    def launch(*a):
                        owners[:] = ["gnome-text-editor"]
                        generation[:] = [321, 100]
                        return SimpleNamespace(pid=321, start_time=100)
                    class DeadOwner:
                        @property
                        def name(self):
                            raise TimeoutError("destroyed AT-SPI owner cannot answer Name")
                    def registry(_):
                        if fault == "dead-owner" and not owners:
                            return [DeadOwner()]
                        return [SimpleNamespace(name=n) for n in owners]
                    root = SimpleNamespace(pid=123, children=lambda: [])
                    with patch.object(events, "_editor", return_value=(SimpleNamespace(pid=123, start_time=99, windows=["raw-frame"]), root)), \
                        patch.object(events, "registry", side_effect=registry), \
                        patch.object(events, "members", side_effect=lambda _: [(generation[0], generation[1], "editor")] if owners else []), \
                        patch.object(events, "launch", side_effect=launch), \
                        patch.object(events, "stop", side_effect=lambda _: owners.clear()), \
                        patch.object(events, "delayed", side_effect=lambda _, action: (pending.append(action) or SimpleNamespace(join=lambda: None))), \
                        patch("runner.verdict.run_product", side_effect=product):
                        if fault in (None, "dead-owner"):
                            events.target_killed_mid_wait(ctx)
                            self.assertEqual(verdict.evaluate(ctx), [])
                        else:
                            with self.assertRaises(AssertionError):
                                events.target_killed_mid_wait(ctx)

    def test_window_events_require_the_observed_kind_owner_and_frame(self):
        for scenario in ("scoped_and_unscoped_forms", "window_closed_transition"):
            for field in (None, "kind", "pid", "window_id"):
                for bad_response in ((0, 1) if field and scenario == "scoped_and_unscoped_forms" else (0,)):
                    with self.subTest(scenario=scenario, field=field, response=bad_response):
                        tier = SimpleNamespace(runtime_dir=Path("/private/test"))
                        leg = legs.leg_by_id("events." + scenario)
                        frames, pending, calls, replies = ["seed"], [], [], []
                        app = SimpleNamespace(pid=123, windows=["seed"])
                        root = SimpleNamespace(children=lambda: list(frames))
                        def product(tier, argv, **kw):
                            before = set(frames)
                            pending.pop()()
                            event = {"kind": argv[argv.index("--event") + 1], "pid": 123,
                                     "window_id": next(iter(set(frames) ^ before))}
                            if field is not None and len(calls) == bad_response:
                                event[field] = {"kind": "app-terminated", "pid": 999,
                                                "window_id": "unrelated"}[field]
                            calls.append(argv)
                            replies.append(str(event))
                            return Envelope(True, {"event": event}, None, str(event), 1, argv)
                        def restore(ctx, owner, count, name):
                            frames[:] = ["seed"]
                            ctx.restored("atspi.root_children", len(frames))
                        with tempfile.TemporaryDirectory() as directory, \
                            patch.object(verdict, "_proc_members", return_value=[]), \
                            patch.object(events, "_editor", return_value=(app, root)), \
                            patch.object(events, "_window_ids", side_effect=lambda _: list(frames)), \
                            patch.object(events, "_new_editor_window", side_effect=lambda _: frames.append(f"extra-{len(frames)}")), \
                            patch.object(events, "_close_added_windows", side_effect=lambda _, seed: frames.__setitem__(slice(None), seed)), \
                            patch.object(events, "root_windows", side_effect=lambda *a: len(frames)), \
                            patch.object(events, "_restore_count", side_effect=restore), \
                            patch.object(events, "stop", side_effect=lambda _: frames.clear()), \
                            patch.object(events, "delayed", side_effect=lambda _, action: (pending.append(action) or SimpleNamespace(join=lambda: None))), \
                            patch("runner.verdict.run_product", side_effect=product):
                            outcome = main._run_leg(getattr(events, scenario), leg, tier,
                                                    "x11-openbox", "headless", Path(directory), verdict, report)
                        self.assertEqual(outcome.outcome, report.PASS if field is None else report.FAIL,
                                         outcome.detail)
                        if field is not None:
                            self.assertEqual(outcome.detail, replies[-1])

    def test_process_events_read_transitions_and_restore_private_registry_state(self):
        for kind in ("app_launched_transition", "app_terminated_transition", "app_launched_quiet",
                     "target_killed_mid_wait"):
            with self.subTest(leg=kind):
                tier = SimpleNamespace(runtime_dir=Path("/private/test"))
                leg = legs.Leg("events." + kind, "Process event restores private registry state",
                               "Calculator", ("x11-openbox",), ("headless",), ("atspi", "proc"), "pass")
                ctx = LegContext(tier, "headless", leg,
                                 member_reader=lambda _: frozenset())
                owners, pending = set(), []
                def launch(tier, name, *a):
                    owner = "gnome-calculator" if name == "Calculator" else "gnome-text-editor"
                    owners.add(owner)
                    return SimpleNamespace(name=owner, pid=123, start_time=99, windows=["w-editor"])
                def stop(app):
                    owners.discard(app.name)
                def delayed(seconds, action):
                    pending.append(action)
                    return SimpleNamespace(join=lambda: None)
                def product(tier, argv, **kw):
                    for action in pending:
                        action()
                    pending.clear()
                    if kind.endswith("quiet"):
                        return Envelope(False, None, {"code": "TIMEOUT"}, "{}", 1500, argv)
                    token = argv[argv.index("--event") + 1]
                    return Envelope(True, {"found": True, "event": {"kind": token, "pid": 123, "window_id": "w-editor"}}, None, "{}", 1000, argv)
                with patch.object(events, "launch", side_effect=launch), \
                    patch.object(events, "stop", side_effect=stop), \
                    patch.object(events, "app_root", return_value=object()), \
                    patch.object(events, "registry", side_effect=lambda _: [SimpleNamespace(name=n) for n in owners]), \
                    patch.object(events, "members", side_effect=lambda _: [(123, 99, name) for name in owners]), \
                    patch.object(events, "delayed", side_effect=delayed), \
                    patch("runner.verdict.run_product", side_effect=product):
                    getattr(events, kind)(ctx)
                expected = []
                self.assertEqual(verdict.evaluate(ctx), expected)
                self.assertEqual(owners, set())

    def test_new_window_cycle_closes_only_added_frame_and_preserves_seed(self):
        for wrong_target in (False, True):
            tier = SimpleNamespace(runtime_dir=Path("/private/test"))
            ctx = LegContext(tier, "headless", legs.leg_by_id("events.open_and_close_inside_one_wait"),
                             member_reader=lambda _: frozenset())
            frames, pending, stopped = ["seed"], [], []
            app = SimpleNamespace(name="editor", pid=123)
            root = SimpleNamespace(children=lambda: list(frames))
            def close(tier, existing):
                self.assertEqual(existing, ["seed"])
                frames[:] = existing
            def product(tier, argv, **kw):
                pending.pop()()
                return Envelope(True, {"event": {"kind": "window_closed", "pid": 123, "window_id": "unrelated" if wrong_target else "extra"}}, None, "{}", 1000, argv)
            with patch.object(events, "_editor", return_value=(app, root)), \
                patch.object(events, "_window_ids", side_effect=lambda _: list(frames)), \
                patch.object(events, "_new_editor_window", side_effect=lambda _: frames.append("extra")), \
                patch.object(events, "_close_added_windows", side_effect=close), \
                patch.object(events, "root_windows", side_effect=lambda *a: len(frames)), \
                patch.object(events, "stop", side_effect=stopped.append), \
                patch.object(events, "delayed", side_effect=lambda delay, action: (pending.append(action) or SimpleNamespace(join=lambda: None))), \
                patch("runner.verdict.run_product", side_effect=product):
                if wrong_target:
                    with self.assertRaises(AssertionError):
                        events.open_and_close_inside_one_wait(ctx)
                    continue
                events.open_and_close_inside_one_wait(ctx)
            self.assertEqual(frames, ["seed"])
            self.assertEqual(stopped, [app])
            self.assertEqual(verdict.evaluate(ctx), [])
