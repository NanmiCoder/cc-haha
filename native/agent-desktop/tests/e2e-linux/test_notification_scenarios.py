import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from runner import legs, main, report, verdict
from runner.product import Envelope
from scenarios import notifications


class SingleDismissTests(unittest.TestCase):
    def test_single_dismiss_detects_bystander_closure(self):
        for dismiss_all in (False, True):
            with self.subTest(dismiss_all=dismiss_all), tempfile.TemporaryDirectory() as directory:
                records, signals = {}, []
                def send(app, summary):
                    identifier = 41 + len(records)
                    records[identifier] = {"id": identifier, "app": app, "summary": summary}
                    return identifier
                def active():
                    closed = {data["id"] for _, data in signals}
                    return [record for key, record in records.items() if key not in closed]
                sender = SimpleNamespace(send=send, active=active, signals=lambda: signals,
                    wait_closed=lambda ids: [data for _, data in signals if data["id"] in ids])
                @contextmanager
                def observing(ctx):
                    ctx.before("dbus.notifications", [])
                    try:
                        yield sender
                    finally:
                        for record in active():
                            signals.append(("NotificationClosed", {"id": record["id"], "reason": 3}))
                        ctx.restored("dbus.notifications", [])
                def product(tier, argv, **kw):
                    entries = [{"index": index, "app_name": row["app"], "title": row["summary"]}
                               for index, row in enumerate(active(), 1)]
                    if argv[0] == "list-notifications":
                        if "--app" in argv:
                            entries = [row for row in entries if argv[-1] in row["app_name"]]
                        return Envelope(True, {"notifications": entries}, None, "{}", 0, argv)
                    if argv[-1] == "HarnessWrong":
                        return Envelope(False, None, {"code": "NOTIFICATION_NOT_FOUND"}, "{}", 0, argv)
                    target = entries[int(argv[1]) - 1]["app_name"]
                    for record in active():
                        if dismiss_all or record["app"] == target:
                            signals.append(("NotificationClosed", {"id": record["id"], "reason": 2}))
                    return Envelope(True, {}, None, "{}", 0, argv)
                with patch.object(notifications.notify, "observing", side_effect=observing), \
                    patch.object(notifications, "poll", side_effect=lambda read, *a: read()), \
                    patch.object(verdict, "_proc_members", return_value=[]), \
                    patch("runner.verdict.run_product", side_effect=product):
                    outcome = main._run_leg(notifications.dismiss_notification_closes_only_target,
                        legs.leg_by_id("notifications.dismiss_notification_closes_only_target"),
                        SimpleNamespace(runtime_dir=Path(directory)), "x11-mutter", "headed",
                        Path(directory), verdict, report)
                self.assertEqual(outcome.outcome, report.FAIL if dismiss_all else report.PASS, outcome.detail)
                if dismiss_all:
                    self.assertIn("NotificationClosed", outcome.detail)
                    self.assertIn("'id': 42", outcome.detail)
                self.assertEqual(set(records), {41, 42})
