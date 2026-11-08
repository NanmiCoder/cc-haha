import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from runner import legs, verdict
from runner.product import Envelope
from runner.verdict import LegContext
from scenarios import clipboard


class ClipboardScenarioTests(unittest.TestCase):
    def test_every_clipboard_leg_reads_foreign_state_and_releases_its_owners(self):
        for leg in (row for row in legs.REGISTRY if row.id.startswith("clipboard.")):
            with self.subTest(leg=leg.id), tempfile.TemporaryDirectory() as directory:
                tier = SimpleNamespace(runtime_dir=Path(directory))
                ctx = LegContext(tier, "headless", leg, member_reader=lambda _: frozenset())
                selection, owners = {}, set()
                def foreign_set(tier, fmt, payload):
                    selection.clear()
                    selection[fmt] = payload
                    owners.add(101)
                    return 101
                def foreign_get(tier, fmt):
                    return selection.get(fmt)
                def stop(pid):
                    owners.remove(pid)
                def product(tier, argv, **kw):
                    data = {}
                    if argv[0] == "clipboard-clear":
                        selection.clear()
                    elif argv[0] == "clipboard-set":
                        selection.clear()
                        if argv[1] == "--image":
                            selection["image/png"] = Path(argv[2]).read_bytes()
                        else:
                            selection["text/plain"] = argv[1].encode()
                    elif argv[0] == "clipboard-get":
                        fmt = argv[-1]
                        if fmt == "image":
                            path = Path(directory) / "read.png"
                            path.write_bytes(selection["image/png"])
                            data = {"path": str(path)}
                        else:
                            payload = selection.get("text/plain", b"")
                            data = {"type": "text", "text": payload.decode()}
                    return Envelope(True, data, None, "{}", 0, argv)
                with patch.object(clipboard.oracle_clipboard, "foreign_set", side_effect=foreign_set), \
                    patch.object(clipboard.oracle_clipboard, "foreign_get", side_effect=foreign_get), \
                    patch.object(clipboard, "stop_owner", side_effect=stop), \
                    patch("runner.verdict.run_product", side_effect=product):
                    getattr(clipboard, leg.id.partition(".")[2])(ctx)
                self.assertEqual(verdict.evaluate(ctx), [])
                self.assertEqual(selection, {})
                self.assertEqual(owners, set())
