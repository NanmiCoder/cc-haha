import sys
import tempfile
import unittest
from contextlib import nullcontext
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from oracle import atspi_raw as raw
from runner import apps, legs, main, report, session


class Owner:
    def __init__(self, bus, name, children=()):
        self.bus = bus
        self._name = name
        self.children = Mock(return_value=children)
        self.name_reads = 0

    @property
    def name(self):
        self.name_reads += 1
        if isinstance(self._name, Exception):
            raise self._name
        return self._name


class RuntimeReadinessTests(unittest.TestCase):
    def setUp(self):
        self.tier = SimpleNamespace(name="x11-mutter", runtime_dir=Path("/private/a"),
                                    display=":150", a11y_bus_address="private-a11y",
                                    bus_address="private-session")

    def test_discovery_skips_shell_and_isolates_unrelated_name_and_frame_timeouts(self):
        shell = Owner(":1.11", TimeoutError("shell name stalled"))
        bystander = Owner(":1.2", TimeoutError("unrelated name stalled"))
        frame_error = Owner(":1.3", "unrelated")
        frame_error.children.side_effect = TimeoutError("unrelated frames stalled")
        frame = SimpleNamespace(role=23, bus=":1.4", path="/frame",
                                interfaces=lambda: ["org.a11y.atspi.Component"])
        target = Owner(":1.4", "gnome-calculator", [frame])
        def facts(pid):
            return 99, pid, "gnome-shell" if pid == 11 else "app", {
                "XDG_RUNTIME_DIR": "/private/a", "DISPLAY": ":150"}
        with patch.object(raw, "registry", return_value=[shell, bystander, frame_error, target]), \
             patch.object(raw, "owner_pid", side_effect=lambda node: int(node.bus.split(".")[-1])), \
             patch.object(apps.proc, "facts", side_effect=facts):
            found = apps.owners_named(self.tier, "Calculator")
        self.assertEqual([app.pid for app in found], [4])
        self.assertEqual(shell.name_reads, 0)
        shell.children.assert_not_called()
        frame_error.children.assert_not_called()

    def test_target_failure_is_never_replaced_with_an_unrelated_frame(self):
        target = Owner(":1.4", "gnome-calculator")
        target.children.side_effect = TimeoutError("target frames stalled")
        with patch.object(raw, "registry", return_value=[target]), \
             patch.object(raw, "owner_pid", return_value=4), \
             patch.object(apps.proc, "facts", return_value=(99, 4, "gnome-calculat", {
                 "XDG_RUNTIME_DIR": "/private/a"})):
            with self.assertRaisesRegex(TimeoutError, "target frames stalled"):
                apps.owners_named(self.tier, "Calculator")

    def test_target_name_timeout_cannot_make_another_owner_the_unique_candidate(self):
        target = Owner(":1.4", TimeoutError("target name stalled"))
        frame = SimpleNamespace(role=23, bus=":1.5", path="/frame",
                                interfaces=lambda: ["org.a11y.atspi.Component"])
        other = Owner(":1.5", "gnome-calculator", [frame])
        with patch.object(raw, "registry", return_value=[target, other]), \
             patch.object(raw, "owner_pid", side_effect=lambda node: int(node.bus.split(".")[-1])), \
             patch.object(apps.proc, "facts", return_value=(99, 4, "gnome-calculato", {
                 "XDG_RUNTIME_DIR": "/private/a"})):
            with self.assertRaisesRegex(TimeoutError, "target name stalled"):
                apps.owners_named(self.tier, "Calculator")

    def test_unique_bus_lookup_never_reads_names_and_checks_private_ownership(self):
        target = Owner(":1.4", TimeoutError("target name not needed"))
        with patch.object(raw, "registry", side_effect=AssertionError("registry not needed")), \
             patch.object(raw, "connect", return_value=object()), \
             patch.object(raw, "owner_pid", return_value=4), \
             patch.object(raw, "RawNode", return_value=target), \
             patch.object(apps.proc, "facts", return_value=(99, 4, "app", {
                 "XDG_RUNTIME_DIR": "/private/a"})):
            self.assertIs(raw.app_root(self.tier, ":1.4"), target)
        self.assertEqual(target.name_reads, 0)
        with patch.object(raw, "connect", return_value=object()), \
             patch.object(raw, "owner_pid", return_value=4), \
             patch.object(apps.proc, "facts", return_value=(99, 4, "app", {
                 "XDG_RUNTIME_DIR": "/private/ab"})):
            with self.assertRaises(LookupError):
                raw.app_root(self.tier, ":1.4")

    def test_named_lookup_isolates_unrelated_timeout(self):
        bad = Owner(":1.1", TimeoutError("bystander stalled"))
        target = Owner(":1.4", "Calculator")
        with patch.object(raw, "registry", return_value=[bad, target]), \
             patch.object(raw, "owner_pid", return_value=4), \
             patch.object(apps.proc, "facts", return_value=(99, 4, "app", {
                 "XDG_RUNTIME_DIR": "/private/a"})):
            self.assertIs(raw.app_root(self.tier, "Calculator"), target)

    def test_unattributed_owner_pid_timeout_cannot_establish_a_unique_named_owner(self):
        unknown, other = Owner(":1.3", "Calculator"), Owner(":1.4", "Calculator")
        with patch.object(raw, "registry", return_value=[unknown, other]), \
             patch.object(raw, "owner_pid", side_effect=[TimeoutError("PID unknown"), 4]), \
             patch.object(apps.proc, "facts", return_value=(99, 4, "app", {
                 "XDG_RUNTIME_DIR": "/private/a"})):
            with self.assertRaisesRegex(TimeoutError, "PID unknown"):
                raw.app_root(self.tier, "Calculator")
        retired = RuntimeError("org.freedesktop.DBus.Error.NameHasNoOwner")
        with patch.object(raw, "registry", return_value=[unknown, other]), \
             patch.object(raw, "owner_pid", side_effect=[retired, 4, 4]), \
             patch.object(apps.proc, "facts", return_value=(99, 4, "app", {
                 "XDG_RUNTIME_DIR": "/private/a"})):
            self.assertIs(raw.app_root(self.tier, "Calculator"), other)

    def test_late_mapping_never_returns_an_app_and_reaps_its_owned_generation(self):
        clock = [0.0]
        app = apps.OwnedApp("Calculator", 123, 99, [":1.4"], ["w-frame"], ":150")
        def mapped(*args):
            self.assertLessEqual(raw.remaining_timeout(5), 0.5)
            clock[0] = 0.6
            return True
        with tempfile.TemporaryDirectory() as directory:
            self.tier.runtime_dir = Path(directory)
            self.tier.env = {}
            with patch.object(apps, "_owners", side_effect=[[], [app]]), \
                 patch.object(apps, "_display_verified", side_effect=mapped), \
                 patch.object(apps.subprocess, "Popen", return_value=SimpleNamespace(pid=123)), \
                 patch.object(apps.time, "monotonic", side_effect=lambda: clock[0]), \
                 patch("runner.readiness.wait_ready"), \
                 patch.object(apps, "stop") as stop, \
                 patch.dict(apps._TIERS, clear=True), patch.dict(apps._SPAWNED, clear=True):
                with self.assertRaisesRegex(session.TierUnavailable, "mapping responsiveness"):
                    apps.launch(self.tier, "Calculator", settle_s=0.5)
                stop.assert_called_once_with(app)

    def test_unresponsive_tier_executes_no_leg_and_never_passes(self):
        from runner import readiness
        leg = legs.leg_by_id("observation.qualified_refs_survive_snapshots")
        with patch.object(session, "start_tier", return_value=nullcontext(self.tier)), \
             patch.object(apps, "prime_desktop"), \
             patch.object(readiness, "wait_ready", side_effect=session.TierUnavailable("WM stalled")), \
             patch.object(main, "_run_leg") as run:
            outcomes = main._run_tier(self.tier.name, [leg], {leg.id: object()}, Path("/unused"), False)
        run.assert_not_called()
        self.assertEqual([row.outcome for row in outcomes], [report.TIER_UNAVAILABLE])
        self.assertEqual(report.count_failures(outcomes), 1)

    def test_responsiveness_gate_recovers_or_expires_without_unobserved_escape(self):
        from runner import readiness
        for recovering in (True, False):
            clock = [0.0]
            def probe(tier, app):
                if not recovering or clock[0] < 0.2:
                    raise TimeoutError("shell AT-SPI stalled")
            with self.subTest(recovering=recovering), \
                 patch.object(readiness, "probe", side_effect=probe), \
                 patch.object(readiness.time, "monotonic", side_effect=lambda: clock[0]), \
                 patch.object(readiness.time, "sleep", side_effect=lambda n: clock.__setitem__(0, clock[0] + n)):
                if recovering:
                    readiness.wait_ready(self.tier, seconds=0.5)
                    self.assertGreaterEqual(clock[0], 0.2)
                else:
                    with self.assertRaisesRegex(session.TierUnavailable, "shell AT-SPI stalled"):
                        readiness.wait_ready(self.tier, seconds=0.5)
                    self.assertLessEqual(clock[0], 0.6)

    def test_overview_escape_requires_observed_true(self):
        from runner import readiness
        for active in (False, True):
            with self.subTest(active=active), \
                 patch.object(readiness.x11, "overview_active", return_value=active), \
                 patch.object(readiness, "close_overview") as close, \
                 patch.object(readiness, "shell_root", return_value=SimpleNamespace(name="gnome-shell", children=lambda: [])), \
                 patch.object(raw, "registry", return_value=[]):
                if active:
                    with self.assertRaisesRegex(RuntimeError, "Overview"):
                        readiness.probe(self.tier, None)
                    close.assert_called_once_with(self.tier)
                else:
                    readiness.probe(self.tier, None)
                    close.assert_not_called()

    def test_late_responsiveness_sample_is_unavailable_and_calls_use_remaining_time(self):
        from runner import readiness
        clock = [0.0]
        def late(*args):
            clock[0] = 0.6
        with patch.object(readiness, "probe", side_effect=late), \
             patch.object(readiness.time, "monotonic", side_effect=lambda: clock[0]):
            with self.assertRaisesRegex(session.TierUnavailable, "after its deadline"):
                readiness.wait_ready(self.tier, seconds=0.5)
        connection = Mock()
        connection.call_sync.return_value.unpack.return_value = ()
        repo = SimpleNamespace(Gio=SimpleNamespace(DBusCallFlags=SimpleNamespace(NONE=0)),
                               GLib=SimpleNamespace(Variant=lambda *args: None))
        with patch.dict(sys.modules, {"gi.repository": repo}), \
             patch.object(raw.time, "monotonic", return_value=4.8), raw.bounded_until(5.0):
            raw.call(connection, "bus", "/path", "interface", "method")
            timeout_ms = connection.call_sync.call_args.args[-2]
            self.assertGreater(timeout_ms, 0)
            self.assertLessEqual(timeout_ms, 200)
