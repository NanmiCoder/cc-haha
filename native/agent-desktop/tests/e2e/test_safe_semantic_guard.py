#!/usr/bin/env python3
import unittest

from safe_semantic_guard import (
    SafetyError,
    fixture_window_identity,
    frontmost_identity,
    non_fixture_frontmost_identity,
    unique_target,
    unique_value,
    validate_command,
    validate_semantic_action,
)


APP = "AgentDeskFixture"
WINDOW = "w-fixture"
PID = 4242
INSTANCE = "4242:fixture-generation"


def fixture_windows(**overrides):
    window = {
        "id": WINDOW,
        "title": "AgentDesk Fixture",
        "app_name": APP,
        "pid": PID,
        "process_instance": INSTANCE,
        "is_focused": False,
        "visible": True,
        "minimized": False,
    }
    window.update(overrides)
    return [window]


def action_data(action="click", delivery="delivered_verified", mechanism="semantic_api"):
    return {
        "action": action,
        "disposition": {"delivery": delivery, "retry": "unsafe"},
        "steps": [
            {
                "label": "AXPress",
                "outcome": "succeeded",
                "mechanism": mechanism,
                "verified": True,
            }
        ],
    }


class CommandPolicyTests(unittest.TestCase):
    def test_value_readback_requires_owned_window_and_snapshot(self):
        command = ["get", "@snap-1:e2", "--property", "value"]
        validate_command(command, APP, WINDOW, False)
        for argv, window in [(command, ""), (command[:2], WINDOW), (command[:-1] + ["text"], WINDOW)]:
            with self.assertRaises(SafetyError):
                validate_command(argv, APP, window, False)

    def test_allows_only_exact_fixture_scoped_observations(self):
        validate_command(["version"], APP, "", False)
        validate_command(["permissions"], APP, "", False)
        validate_command(["list-windows"], APP, "", False)
        validate_command(["list-windows", "--app", APP], APP, "", False)
        validate_command(
            [
                "find", "--app", APP, "--window-id", WINDOW,
                "--role", "button", "--name", "primary-button",
                "--exact", "--limit", "2",
            ],
            APP,
            WINDOW,
            False,
        )
        validate_command(
            [
                "find", "--app", APP, "--window-id", WINDOW,
                "--role", "statictext", "--native-id", "click-status",
                "--exact", "--limit", "2",
            ],
            APP,
            WINDOW,
            False,
        )

    def test_rejects_unscoped_or_non_allowlisted_find(self):
        with self.assertRaises(SafetyError):
            validate_command(
                [
                    "find", "--app", APP, "--role", "button",
                    "--name", "primary-button", "--exact", "--limit", "2",
                ],
                APP,
                WINDOW,
                False,
            )
        with self.assertRaises(SafetyError):
            validate_command(
                [
                    "find", "--app", APP, "--window-id", WINDOW,
                    "--role", "button", "--name", "delete-button",
                    "--exact", "--limit", "2",
                ],
                APP,
                WINDOW,
                False,
            )

    def test_rejects_every_banned_command_class(self):
        banned = [
            ["list-apps", "--app", APP],
            ["focus-window", "--app", APP],
            ["launch", APP],
            ["close-app", APP],
            ["press", "cmd+a"],
            ["mouse-click", "--xy", "1,1"],
            ["hover", "@snap:e1"],
            ["drag", "@snap:e1", "@snap:e2"],
            ["clipboard-get"],
            ["clipboard-set", "secret"],
            ["screenshot", "--app", APP],
            ["resize-window", WINDOW, "800", "600"],
            ["move-window", WINDOW, "0", "0"],
            ["batch", "commands.json"],
        ]
        for argv in banned:
            with self.subTest(argv=argv), self.assertRaises(SafetyError):
                validate_command(argv, APP, WINDOW, True)

    def test_rejects_headed_trace_wait_and_unknown_flags(self):
        variants = [
            ["list-windows", "--headed"],
            ["list-windows", "--trace", "/tmp/trace"],
            ["list-windows", "--wait-for", "button:x"],
            ["list-windows", "--verbose"],
        ]
        for argv in variants:
            with self.subTest(argv=argv), self.assertRaises(SafetyError):
                validate_command(argv, APP, WINDOW, False)

    def test_mutations_require_arming_ref_snapshot_and_timeout(self):
        click = ["click", "@snap-1:e1", "--timeout-ms", "1500"]
        validate_command(click, APP, WINDOW, True)
        for armed, window, argv in [
            (False, WINDOW, click),
            (True, "", click),
            (True, WINDOW, ["click", "@snap-1:e1"]),
            (True, WINDOW, ["click", "@snap-1:e1", "--timeout-ms", "9000"]),
        ]:
            with self.assertRaises(SafetyError):
                validate_command(argv, APP, window, armed)

    def test_text_payloads_are_narrowly_bounded(self):
        for command in ["type", "set-value"]:
            validate_command(
                [
                    command, "@snap-1:e2", "safe-semantic-4242",
                    "--timeout-ms", "1500",
                ],
                APP,
                WINDOW,
                True,
            )
        unsafe = [[
            "set-value", "@snap-1:e2", "arbitrary user text",
            "--timeout-ms", "1500",
        ]]
        for argv in unsafe:
            with self.subTest(argv=argv), self.assertRaises(SafetyError):
                validate_command(argv, APP, WINDOW, True)


class IdentityGuardTests(unittest.TestCase):
    def test_frontmost_identity_returns_opaque_process_and_window_tokens_only(self):
        identity = frontmost_identity(
            [
                {
                    "id": "private-window",
                    "title": "Private Document Title",
                    "app_name": "Private App Name",
                    "pid": 99,
                    "process_instance": "99:generation",
                    "is_focused": True,
                    "visible": True,
                    "minimized": False,
                }
            ]
        )
        self.assertEqual(
            identity,
            {"pid": 99, "process_instance": "99:generation", "window_id": "private-window"},
        )

    def test_frontmost_identity_fails_closed_on_ambiguity_or_missing_generation(self):
        base = fixture_windows(is_focused=True)
        with self.assertRaises(SafetyError):
            frontmost_identity(base + fixture_windows(id="another", is_focused=True))
        base[0].pop("process_instance")
        with self.assertRaises(SafetyError):
            frontmost_identity(base)

    def test_frontmost_may_change_between_user_apps_but_never_to_fixture(self):
        other = fixture_windows(
            pid=99,
            process_instance="99:generation",
            is_focused=True,
        )

        identity = non_fixture_frontmost_identity(other, PID)

        self.assertEqual(identity["pid"], 99)
        with self.assertRaises(SafetyError):
            non_fixture_frontmost_identity(fixture_windows(is_focused=True), PID)

    def test_fixture_identity_binds_pid_generation_and_one_unfocused_window(self):
        identity = fixture_window_identity(fixture_windows(), APP, PID)
        self.assertEqual(identity["pid"], PID)
        self.assertEqual(identity["process_instance"], INSTANCE)
        self.assertEqual(identity["window_id"], WINDOW)

    def test_fixture_identity_ignores_owned_hidden_companion_window(self):
        hidden = fixture_windows(
            id="hidden-companion",
            title="Hidden Companion",
            visible=False,
            minimized=False,
        )

        identity = fixture_window_identity(fixture_windows() + hidden, APP, PID)

        self.assertEqual(identity["window_id"], WINDOW)

    def test_fixture_identity_rejects_focus_wrong_pid_and_surface_ambiguity(self):
        cases = [
            (fixture_windows(is_focused=True), PID),
            (fixture_windows(), PID + 1),
            (fixture_windows() + fixture_windows(id="second", visible=True), PID),
        ]
        for windows, pid in cases:
            with self.subTest(pid=pid, windows=len(windows)), self.assertRaises(SafetyError):
                fixture_window_identity(windows, APP, pid)


class ResultGuardTests(unittest.TestCase):
    def test_unique_target_and_status_reject_ambiguous_results(self):
        target = {
            "snapshot_id": "snap-1",
            "matches": [
                {
                    "role": "button",
                    "name": "primary-button",
                    "interactive": True,
                    "ref_id": "@snap-1:e1",
                }
            ],
        }
        self.assertEqual(unique_target(target, "button", "primary-button"), ("@snap-1:e1", "snap-1"))
        with self.assertRaises(SafetyError):
            unique_target({**target, "matches": target["matches"] * 2}, "button", "primary-button")
        value = {
            "matches": [
                {
                    "role": "statictext",
                    "name": "dynamic-value",
                    "interactive": False,
                    "value": None,
                }
            ]
        }
        self.assertEqual(unique_value(value, "text-echo"), "")
        with self.assertRaises(SafetyError):
            unique_value({"matches": [{**value["matches"][0], "interactive": True}]}, "text-echo")

    def test_changed_action_requires_a_semantic_successful_delivery(self):
        validate_semantic_action(action_data(), "click", "changed")
        for bad in [
            action_data(mechanism="physical_synthetic"),
            action_data(delivery="not_delivered"),
            {**action_data(), "steps": []},
        ]:
            with self.assertRaises(SafetyError):
                validate_semantic_action(bad, "click", "changed")

    def test_noop_action_requires_explicit_not_delivered_evidence(self):
        noop = {
            "action": "check",
            "disposition": {"delivery": "not_delivered", "retry": "safe"},
            "steps": [{"label": "AlreadyInState", "outcome": "skipped", "verified": True}],
        }
        validate_semantic_action(noop, "check", "noop")
        with self.assertRaises(SafetyError):
            validate_semantic_action(action_data(action="check"), "check", "noop")


if __name__ == "__main__":
    unittest.main()
