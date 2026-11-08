import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from runner import legs, verdict
from runner.product import Envelope
from runner.verdict import LegContext
from scenarios import wayland_input


class WaylandInputScenarioTests(unittest.TestCase):
    def test_key_and_modifier_legs_use_real_keys_and_restore_the_document(self):
        for name in ("first_key_lands", "modifiers_work", "key_before_throwaway_not_rescued"):
            for lying in (False, True):
                with self.subTest(leg=name, lying=lying):
                    tier = SimpleNamespace(runtime_dir=Path("/private/test"))
                    contract = legs.Leg("wayland_input." + name, "Read and restore key effects",
                                        "fake editor", ("wayland",), ("headless",),
                                        ("atspi", "clipboard"), "pass")
                    ctx = LegContext(tier, "headless", contract,
                                     member_reader=lambda _: frozenset())
                    text, selected = [""], [False]
                    def product(tier, argv, **kw):
                        if argv[0] == "press" and not lying:
                            if argv[1] == "ctrl+a":
                                selected[0] = True
                            else:
                                text[0] += argv[1]
                        elif argv[0] == "type":
                            text[0] = argv[-1] if selected[0] else text[0] + argv[-1]
                            selected[0] = False
                        elif argv[0] == "clear":
                            text[0] = ""
                        return Envelope(True, {}, None, "{}", 0, argv)
                    with patch.object(wayland_input, "_editor", return_value=(object(), object(), "@s:e1")), \
                        patch.object(wayland_input, "_window_id", return_value="w-editor"), \
                        patch.object(wayland_input, "document_text", side_effect=lambda _: text[0]), \
                        patch.object(wayland_input, "app_root", return_value=object()), \
                        patch.object(wayland_input, "stop"), \
                        patch.object(wayland_input, "poll", side_effect=lambda read, *a, **kw: read()), \
                        patch("oracle.atspi_raw.poll", side_effect=lambda read, *a, **kw: read()), \
                        patch("runner.verdict.run_product", side_effect=product):
                        if lying:
                            with self.assertRaises(AssertionError):
                                getattr(wayland_input, name)(ctx)
                        else:
                            getattr(wayland_input, name)(ctx)
                            self.assertEqual(verdict.evaluate(ctx), [])
                            before = ctx.reads["atspi.document_text"]["before"][0]
                            self.assertEqual(text[0], before)
                    self.assertTrue(any(row.argv[:2] == ["press", "h"] for row in ctx.products)
                                    if name == "first_key_lands" else True)

    def test_find_bar_requires_a_showing_search_field_and_restores_closed(self):
        tier = SimpleNamespace(runtime_dir=Path("/private/test"))
        ctx = LegContext(tier, "headless", None,
                         member_reader=lambda _: frozenset())
        opened = [False]
        toolbar = SimpleNamespace(role=43, name="Find and Replace", states={"SHOWING"})
        field = SimpleNamespace(role=79, name="Search for", states=set())
        root = SimpleNamespace(role=0, name="", states=set(), children=lambda: [toolbar, field])
        toolbar.children = field.children = lambda: []
        def product(tier, argv, **kw):
            opened[0] = argv[1] == "ctrl+f"
            field.states = {"SHOWING"} if opened[0] else set()
            return Envelope(True, {}, None, "{}", 0, argv)
        with patch.object(wayland_input, "_editor", return_value=(object(), root, "@s:e1")), \
            patch.object(wayland_input, "_window_id", return_value="w-editor"), \
            patch.object(wayland_input, "app_root", return_value=root), \
            patch.object(wayland_input, "stop"), \
            patch("oracle.atspi_raw.poll", side_effect=lambda read, *a, **kw: read()), \
            patch("runner.verdict.run_product", side_effect=product):
            wayland_input.ctrl_f_two_keycodes(ctx)
        self.assertFalse(opened[0])
        self.assertEqual(verdict.evaluate(ctx), [])
