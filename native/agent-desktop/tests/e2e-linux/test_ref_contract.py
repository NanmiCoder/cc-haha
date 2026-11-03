import unittest
from contextlib import nullcontext
from unittest.mock import Mock, patch
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import json

from scenarios.ref_contract import expected_outcomes, row_verdict, fresh, prepare, named, selected, effect, closes_fixture, close_fixture, unsupported, refs
from scenarios.ref_contract_windows import chooser, window_state
from scenarios.ref_contract_identity import identify, raw_target
from oracle.atspi_raw import RawNode


class RefContractTests(unittest.TestCase):
    def test_window_observation_requires_fresh_parent_proof_before_ignoring_a_failed_child(self):
        class Closing:
            bus, path = ":1.5", "/closing"

            @property
            def states(self):
                raise RuntimeError("accessible destroyed")

        node = Closing()
        for refreshed in ([], [node]):
            tree = SimpleNamespace(children=Mock(side_effect=[[node], refreshed]))
            if refreshed:
                with self.assertRaises(RuntimeError):
                    window_state(tree)
            else:
                self.assertEqual(window_state(tree), ())

    def test_combo_switch_requires_matching_open_event_and_pressed_state(self):
        target = SimpleNamespace(states={"PRESSED"})
        node = {"name": "Alpha", "role": "switch"}
        record = {"widget": "zoo-combo", "event": "opened", "value": True}
        with patch("scenarios.ref_contract.raw_target", return_value=target):
            self.assertEqual(effect(None, node, "click", None, [], [record]), (True, True))
            self.assertEqual(effect(None, node, "click", None, [], []), (False, True))
            target.states.clear()
            self.assertEqual(effect(None, node, "click", None, [], [record]), (True, False))

    def test_unsupported_selection_preparation_allows_refusal_but_collapse_is_not_exercised(self):
        node = {"name": "zoo-tab-a", "role": "tab", "available_actions": ["Select"]}
        other = dict(node, name="zoo-tab-b")
        error = {"code": "ACTION_NOT_SUPPORTED", "details": {"kind": "selection_index_unproven"},
                 "disposition": {"delivery": "not_delivered"}}
        with patch("scenarios.ref_contract.selected", return_value=True), \
                patch("scenarios.ref_contract.snapshot"), \
                patch("scenarios.ref_contract.named", return_value=other), \
                patch("scenarios.ref_contract.act", return_value=SimpleNamespace(error=error)), \
                patch("scenarios.ref_contract.poll") as poll:
            self.assertIs(prepare(None, None, None, node, "select"), node)
            combo = {"name": "Alpha", "role": "combobox", "available_actions": ["Collapse"]}
            with self.assertRaisesRegex(NotImplementedError, "collapse not exercised"):
                prepare(None, None, None, combo, "collapse")
        poll.assert_not_called()

    def test_unsupported_requires_a_specific_safe_refusal_and_no_effects(self):
        error = {"code": "ACTION_NOT_SUPPORTED", "details": {"kind": "selection_index_unproven"},
                 "disposition": {"delivery": "not_delivered"}}
        self.assertTrue(unsupported(error))
        for code in ("STALE_REF", "AMBIGUOUS_TARGET", "TIMEOUT", "INTERNAL"):
            self.assertFalse(unsupported(dict(error, code=code)))
        self.assertFalse(unsupported(dict(error, details={})))
        self.assertFalse(unsupported(dict(error, disposition={"delivery": "delivery_uncertain"})))
        for log, raw in ((False, True), (True, False)):
            self.assertEqual(row_verdict("refuse", succeeded=False, refused=unsupported(error), log_effect=False,
                                         raw_effect=False, log_unchanged=log, raw_unchanged=raw), "fail")

    def test_advertised_action_refusal_cannot_rewrite_the_snapshot_promise(self):
        node = {"name": "Alpha", "role": "combobox", "available_actions": ["Expand"]}
        error = {"code": "ACTION_NOT_SUPPORTED", "details": {"kind": "native_popup_requires_input"},
                 "disposition": {"delivery": "not_delivered"}}
        ctx = SimpleNamespace(reads={}, before=Mock(), after=Mock())
        with patch("scenarios.ref_contract.zoo", return_value=nullcontext((None, None))), \
                patch("scenarios.ref_contract.root"), \
                patch("scenarios.ref_contract.snapshot", return_value={"ref_id": "e1", **node}), \
                patch("scenarios.ref_contract.fresh", return_value=node), \
                patch("scenarios.ref_contract.prepare", return_value=node), \
                patch("scenarios.ref_contract.raw_state", return_value=()), \
                patch("scenarios.ref_contract.events", return_value=[]), \
                patch("scenarios.ref_contract.since_reset", return_value=[]), \
                patch("scenarios.ref_contract.reset"), \
                patch("scenarios.ref_contract.effect", return_value=(False, False)), \
                patch("scenarios.ref_contract.poll", side_effect=lambda read, *a, **kw: read()), \
                patch("scenarios.ref_contract.act", return_value=SimpleNamespace(ok=False, error=error, exit_code=1)), \
                patch("scenarios.ref_contract.print_rows") as report:
            with self.assertRaisesRegex(AssertionError, "ref-contract table has failures"):
                refs(ctx)
        row = report.call_args.args[1][0]
        self.assertEqual(row["expected"], ["land"])
        self.assertEqual(row["verdict"], "fail")

    def test_close_runs_last_and_restores_a_new_fixture_after_observed_exit(self):
        close = {"name": "Close", "role": "button"}
        entry = {"name": "zoo-entry", "role": "textfield"}
        self.assertEqual(sorted([close, entry], key=closes_fixture), [entry, close])
        for succeeded in (True, False):
            observed = {}
            ctx = SimpleNamespace(**{stage: lambda channel, value, s=stage: observed.setdefault((channel, s), value)
                                    for stage in ("before", "after", "restored")})
            tree = SimpleNamespace(connection=None, bus=":1.5")
            record = {"widget": "zoo", "event": "closed", "value": None}
            row = {}
            with patch("scenarios.ref_contract.fresh", return_value=close), \
                    patch("scenarios.ref_contract.events", side_effect=[[], [record]]), \
                    patch("scenarios.ref_contract.since_reset", side_effect=[[], [record], []]), \
                    patch("scenarios.ref_contract.call", return_value=(False,)), \
                    patch("scenarios.ref_contract.poll", side_effect=lambda read, _: read()), \
                    patch("scenarios.ref_contract.act", return_value=SimpleNamespace(ok=succeeded)) as act, \
                    patch("scenarios.ref_contract.zoo", return_value=nullcontext((None, "new-log"))), \
                    patch("scenarios.ref_contract.root"), \
                    patch("scenarios.ref_contract_windows.window_state", return_value=(("Zoo GTK3", 23, False),)):
                close_fixture(ctx, None, tree, "old-log", close, row)
            self.assertEqual(row["verdict"], "pass" if succeeded else "fail")
            self.assertEqual(observed["atspi.close", "after"], ())
            for channel in ("atspi.close", "applog.close"):
                self.assertEqual(observed[channel, "before"], observed[channel, "restored"])
            act.assert_called_once_with(ctx, close, "click")

    def test_entry_activation_requires_the_callback_effect_in_both_oracles(self):
        target = SimpleNamespace(states={"SHOWING"}, text=lambda: "activated", walk=lambda: [])
        node = {"name": "zoo-entry"}
        records = [{"widget": "zoo-entry", "event": "changed", "value": "activated"}]
        with patch("scenarios.ref_contract.raw_target", return_value=target):
            self.assertEqual(effect(None, node, "click", None, [], records), (True, True))
            self.assertEqual(effect(None, node, "click", None, [], []), (False, False))
            target.text = lambda: ""
            self.assertEqual(effect(None, node, "click", None, [], records), (True, False))

    def test_tab_container_named_after_current_page_needs_no_sibling_preparation(self):
        node = {"name": "zoo-tab-a", "role": "tablist", "available_actions": ["Select"]}
        with patch("scenarios.ref_contract.selected") as selected_state, \
                patch("scenarios.ref_contract.act") as act:
            self.assertIs(prepare(None, None, None, node, "select"), node)
        selected_state.assert_not_called()
        act.assert_not_called()

    def test_combo_oracle_does_not_treat_stale_showing_rows_as_an_open_popup(self):
        option = SimpleNamespace(role=32, name="Alpha", states={"SHOWING"})
        popup = SimpleNamespace(role=31, name="", states=set(), walk=lambda: [option])
        target = SimpleNamespace(states=set(), walk=lambda: [popup, option])
        with patch("scenarios.ref_contract.raw_target", return_value=target):
            self.assertEqual(effect(None, {"role": "combobox"}, "collapse", None, [], []),
                             (True, True))
            popup.states.add("SHOWING")
            self.assertEqual(effect(None, {"role": "combobox"}, "collapse", None, [], []),
                             (True, False))

    def test_tab_selection_uses_the_matching_visible_page_when_no_selection_bit_exists(self):
        tab = SimpleNamespace(role=37, states={"FOCUSABLE", "SHOWING"})
        page = SimpleNamespace(role=20, states={"SHOWING"})
        tree = SimpleNamespace(find=lambda **_: [tab, page])
        self.assertTrue(selected(tree, "zoo-tab-a"))
        page.states.clear()
        self.assertFalse(selected(tree, "zoo-tab-a"))
        tree.find = lambda **_: [tab, page, page]
        with self.assertRaises(AssertionError):
            selected(tree, "zoo-tab-a")

    def test_dialog_button_aliases_still_require_one_exact_role_match(self):
        button = {"name": "OK", "role": "button", "ref_id": "@s1:e1"}
        label = dict(button, role="text", ref_id="@s1:e2")
        data = {"tree": {"children": [button, label]}}
        self.assertIs(named(data, ("zoo-dialog-ok", "OK"), "button"), button)
        data["tree"]["children"].append(dict(button, name="zoo-dialog-ok", ref_id="@s1:e3"))
        with self.assertRaises(AssertionError):
            named(data, ("zoo-dialog-ok", "OK"), "button")

    def test_chooser_clicks_the_fixture_save_button_and_requires_a_file(self):
        with TemporaryDirectory() as directory:
            saved = Path(directory) / "note.txt"
            field = {"name": "Name:", "available_actions": ["TypeText"], "ref_id": "@s1:e1"}
            button = {"name": "zoo-save-ok", "available_actions": ["Click"], "ref_id": "@s2:e1"}
            record = {"widget": "zoo-open-chooser", "event": "saved", "value": str(saved)}
            for exists in (False, True):
                if exists:
                    saved.write_text("widget-zoo\n")
                with self.subTest(exists=exists), \
                        patch("scenarios.ref_contract_windows.raw_target", return_value=SimpleNamespace(text=lambda: str(saved))), \
                        patch("scenarios.ref_contract_windows.act") as act, \
                        patch("scenarios.ref_contract_windows.surface_snapshot", return_value={"tree": button}), \
                        patch("scenarios.ref_contract_windows.events", side_effect=[[], [record]]), \
                        patch("scenarios.ref_contract_windows.poll", side_effect=lambda predicate, _: predicate()):
                    if exists:
                        chooser(None, None, None, None, {"tree": field}, saved)
                    else:
                        with self.assertRaises(AssertionError):
                            chooser(None, None, None, None, {"tree": field}, saved)
                    self.assertEqual(act.call_args_list[-1].args, (None, button, "click"))

    def test_chooser_uses_the_visible_name_field_when_a_hidden_pane_has_another(self):
        field = {"name": "Name:", "available_actions": ["TypeText"], "ref_id": "@s1:e1"}
        for state in ("hidden", "offscreen", "disabled"):
            data = {"tree": {"children": [dict(field, name="Name", states=[state]), field]}}
            with self.subTest(state=state), \
                    patch("scenarios.ref_contract_windows.raw_target"), \
                    patch("scenarios.ref_contract_windows.act", side_effect=InterruptedError) as act:
                with self.assertRaises(InterruptedError):
                    chooser(None, None, None, None, data, Path("/tmp/note.txt"))
                act.assert_called_once_with(None, field, "type", "/tmp/note.txt")

    def test_prepare_selects_another_option_using_its_advertised_action(self):
        node = {"name": "zoo-row-1", "role": "option", "available_actions": ["Select"]}
        other = dict(node, name="zoo-row-2", ref_id="@s1:e2")
        with patch("scenarios.ref_contract.selected", return_value=True), \
                patch("scenarios.ref_contract.snapshot"), \
                patch("scenarios.ref_contract.named", return_value=other), \
                patch("scenarios.ref_contract.act") as act, \
                patch("scenarios.ref_contract.poll", return_value=True), \
                patch("scenarios.ref_contract.fresh", return_value=node):
            prepare(None, None, None, node, "select")
        act.assert_called_once_with(None, other, "select", "zoo-row-2")

    def test_raw_text_uses_character_count_for_toolkits_without_negative_end(self):
        node = RawNode(None, ":1.5", "/entry")
        with patch.object(node, "interfaces", return_value=["org.a11y.atspi.Text"]), \
                patch.object(node, "get_property", return_value=6), \
                patch.object(node, "invoke", side_effect=lambda interface, method, signature, args:
                             ("marker" if args == (0, 6) else "",)):
            self.assertEqual(node.text(), "marker")

    def test_raw_mapping_distinguishes_unnamed_and_duplicate_named_nodes(self):
        class Node:
            bus = ":1.5"

            def __init__(self, path, name, children=()):
                self.path, self.name, self._children = path, name, children

            def children(self):
                return self._children

        controls = [Node("/button", "same"), Node("/label", "same"),
                    Node("/bar_a", ""), Node("/bar_b", "")]
        tree = Node("/root", "", [Node("/frame", "window", controls)])
        with TemporaryDirectory() as directory:
            root = Path(directory)
            saved = root / "snapshots" / "s1"
            saved.mkdir(parents=True)
            (saved / "refmap.json").write_text(json.dumps({"inner": {
                "@e1": {"source_window_id": "w-1.5-frame", "path": [0]},
                "@e2": {"source_window_id": "w-1.5-frame", "path": [3]},
                "@e3": {"source_window_id": "w-1.5-frame"},
            }}))
            data = identify(root, {"tree": {"children": [
                {"ref_id": "@s1:e1", "name": "same"}, {"ref_id": "@s1:e2"},
                {"ref_id": "@s1:e3"}]}})
            first, second, window = data["tree"]["children"]
            self.assertIs(raw_target(tree, first), controls[0])
            self.assertIs(raw_target(tree, second), controls[3])
            self.assertIs(raw_target(tree, window), tree.children()[0])

    def test_fresh_ref_uses_address_when_value_name_changes(self):
        original = {"ref_id": "@s1:e1", "role": "tablist", "name": "tab-a",
                    "_identity": ("window", (0, 3))}
        refreshed = dict(original, ref_id="@s2:e2", name="tab-b")
        other = dict(original, ref_id="@s2:e1", _identity=("window", (0, 2)))
        with patch("scenarios.ref_contract.snapshot", return_value={"tree": {
                "children": [other, refreshed]}}):
            self.assertIs(fresh(SimpleNamespace(), None, original), refreshed)

    def test_snapshot_promises_and_blocked_primary_action(self):
        node = {"name": "zoo-entry", "available_actions":
                ["SetFocus", "TypeText", "SetValue", "RightClick", "ScrollTo"]}
        self.assertEqual(expected_outcomes(node), [("type", "land"), ("set-value", "land")])
        for state in ("hidden", "offscreen", "disabled"):
            with self.subTest(state=state):
                self.assertEqual(expected_outcomes(dict(node, states=[state])), [("type", "refuse")])
        self.assertEqual(expected_outcomes({"role": "button"}), [("click", "refuse")])

    def test_all_observable_advertised_actions_are_preserved(self):
        node = {"available_actions": ["Click", "Toggle", "Check", "Uncheck", "TypeText",
                                      "SetValue", "Select", "Expand", "Collapse"]}
        self.assertEqual(expected_outcomes(node), [(a, "land") for a in
                         ("click", "toggle", "check", "uncheck", "type", "set-value",
                          "select", "expand", "collapse")])

    def test_offscreen_exception_does_not_override_hidden_or_disabled(self):
        for states, expected in (([], "land"), (["offscreen"], "land-or-refuse"),
                                 (["hidden", "offscreen"], "refuse"),
                                 (["disabled", "offscreen"], "refuse")):
            with self.subTest(states=states):
                self.assertEqual(expected_outcomes({"name": "zoo-offscreen", "states": states,
                                                   "available_actions": ["Click"]}), [("click", expected)])

    def test_landing_needs_both_oracles_and_refusal_needs_no_effect(self):
        # expected, refusal, log effect, raw effect, unchanged log/raw, verdict
        cases = [
            ("land", False, True, True, False, False, "pass"),
            ("land", False, True, False, False, True, "fail"),
            ("land", False, False, True, True, False, "fail"),
            ("land", False, False, False, True, True, "fail"),  # lying success
            ("land", True, False, False, True, True, "fail"),   # unmarked refusal
            ("refuse", True, False, False, True, True, "pass"),
            ("refuse", False, False, False, True, True, "fail"),
            ("refuse", True, False, False, False, True, "fail"),  # unexpected log
            ("refuse", True, False, False, True, False, "fail"),  # state drift
            ("refuse", False, True, True, False, False, "fail"),
            ("land-or-refuse", False, True, True, False, False, "pass"),
            ("land-or-refuse", True, False, False, True, True, "pass"),
            ("land-or-refuse", False, False, False, True, True, "fail"),
            ("land-or-refuse", True, False, False, True, False, "fail"),
        ]
        for expected, refused, log, raw, log_same, raw_same, verdict in cases:
            with self.subTest(case=(expected, refused, log, raw, log_same, raw_same)):
                self.assertEqual(row_verdict(expected, succeeded=not refused, refused=refused, log_effect=log,
                                              raw_effect=raw, log_unchanged=log_same,
                                              raw_unchanged=raw_same), verdict)
        for expected in ("land", "land-or-refuse"):
            self.assertEqual(row_verdict(expected, succeeded=False, refused=False,
                                         log_effect=True, raw_effect=True,
                                         log_unchanged=False, raw_unchanged=False), "fail")


if __name__ == "__main__":
    unittest.main()
