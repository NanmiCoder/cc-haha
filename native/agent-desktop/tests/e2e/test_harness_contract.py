import re
import os
import subprocess
import tempfile
import unittest
from pathlib import Path


E2E_ROOT = Path(__file__).resolve().parent
SOURCED_SUITE_FILES = [
    E2E_ROOT / "lib.sh",
    *sorted((E2E_ROOT / "scenarios").glob("*.sh")),
]

class HarnessContractTests(unittest.TestCase):
    def test_sourced_suite_has_one_canonical_exit_path(self):
        exits = []
        abort_calls = []
        for path in SOURCED_SUITE_FILES:
            source = path.read_text()
            for line_number, line in enumerate(source.splitlines(), start=1):
                if re.fullmatch(r"\s*exit 1\s*", line):
                    exits.append((path.name, line_number))
                if re.search(r"\babort_suite\s+\"", line):
                    abort_calls.append((path.name, line_number))

        self.assertEqual(len(exits), 1, exits)
        self.assertEqual(exits[0][0], "lib.sh")
        self.assertTrue(abort_calls)
        source = (E2E_ROOT / "lib.sh").read_text()
        abort = re.search(r"abort_suite\(\) \{(?P<body>.*?)\n\}", source, re.DOTALL)
        self.assertIsNotNone(abort)
        body = abort.group("body")
        self.assertIn('badmsg "$1"', body)
        self.assertIn("finish", body)
        self.assertNotIn("cleanup", body)
        self.assertRegex(body, r"(?m)^\s*exit 1\s*$")
        finish = re.search(r"finish\(\) \{(?P<body>.*?)\n\}", source, re.DOTALL)
        self.assertIsNotNone(finish)
        self.assertNotIn("abort_suite", finish.group("body"))

    def test_json_parsed_captures_read_stdout_only(self):
        offenders = [
            f"{path.name}:{number}"
            for path in SOURCED_SUITE_FILES
            for number, line in enumerate(path.read_text().splitlines(), 1)
            if '2>&1)"' in line
        ]
        self.assertEqual(
            offenders,
            [],
            "the JSON envelope is on stdout; a capture that merges stderr "
            "breaks json_tool when the binary logs a warning",
        )

    def test_denied_automation_skips_when_notification_center_cannot_be_closed(self):
        source = (E2E_ROOT / "scenarios" / "acceptance.sh").read_text()

        unavailable = source.index(
            "Notification Center could not be proven closed after best-effort preparation"
        )
        permission_gate = source.index(
            'if [ "$(json_field "$nc_probe" error.code)" != "POLICY_DENIED" ]'
        )
        denial_call = source.index('denied_output="$("$bin" --headed list-notifications')
        self.assertLess(permission_gate, unavailable)
        self.assertLess(unavailable, denial_call)
        self.assertIn("skipmsg", source[permission_gate:denial_call])
        self.assertNotIn("badmsg", source[permission_gate:denial_call])

    def test_native_runner_gates_on_strict_headless_non_interference(self):
        source = (E2E_ROOT / "run.sh").read_text()

        safe_gate = source.index('bash "$here/safe-semantic.sh"')
        focused_fixture = source.index("prepare_native_harness")
        self.assertLess(safe_gate, focused_fixture)

    def test_multi_agent_probe_runs_before_the_interaction_lease_is_released(self):
        source = (E2E_ROOT / "run.sh").read_text()
        lease_holder = source.index('exec python3 "$here/interaction_lock.py"')
        probe = source.index("cursor-multi-agent-probe.py")
        finishes = [match.start() for match in re.finditer(r"^finish$", source, re.MULTILINE)]

        self.assertEqual(len(finishes), 1)
        self.assertLess(lease_holder, probe)
        self.assertLess(probe, finishes[0])
        for line in source[probe:finishes[0]].splitlines():
            self.assertNotRegex(line, r"\b(exit|exec)\b|release_exclusive_lock")

    def test_native_runner_builds_locked_canonical_artifacts_before_desktop_lock(self):
        source = (E2E_ROOT / "run.sh").read_text()

        cli_build = source.index("cargo build --locked --release -p agent-desktop")
        ffi_build = source.index("cargo build --locked --profile release-ffi")
        desktop_lock = source.index('exec python3 "$here/interaction_lock.py"')
        self.assertLess(cli_build, desktop_lock)
        self.assertLess(ffi_build, desktop_lock)
        self.assertIn(
            'AGENT_DESKTOP_E2E_RELEASE_BIN="$repo/target/release/agent-desktop"',
            source,
        )
        self.assertIn(
            'AGENT_DESKTOP_E2E_RELEASE_FFI="$repo/target/release-ffi/libagent_desktop_ffi.dylib"',
            source,
        )

    def test_post_launch_readiness_failure_still_closes_owned_fixture(self):
        run_source = (E2E_ROOT / "run.sh").read_text()
        opened = run_source.index('guard_exec 10 1048576 open "$fixture_app"')
        owned = run_source.index("fixture_owned=1", opened)
        readiness = run_source.index('if [ -z "$ready" ]', owned)
        self.assertLess(opened, owned)
        self.assertLess(owned, readiness)

        with tempfile.TemporaryDirectory() as directory:
            log = Path(directory) / "calls"
            mock_bin = Path(directory) / "agent-desktop"
            mock_bin.write_text('#!/bin/sh\nprintf "%s\\n" "$*" >> "$MOCK_CALLS"\n')
            mock_bin.chmod(0o700)
            script = r'''
source "$1"
bin="$2"
fixture_owned=1
fixture_started=0
cleanup_isolated_environment() { :; }
release_exclusive_lock() { :; }
cleanup
'''
            environment = os.environ.copy()
            environment["MOCK_CALLS"] = str(log)
            subprocess.run(
                [
                    "bash",
                    "-c",
                    script,
                    "cleanup-test",
                    str(E2E_ROOT / "lib.sh"),
                    str(mock_bin),
                ],
                check=True,
                env=environment,
            )

            self.assertEqual(log.read_text().strip(), "close-app AgentDeskFixture --force")

    def test_success_checks_every_staged_native_artifact_before_returning(self):
        source = (E2E_ROOT / "lib.sh").read_text()
        finish = re.search(r"finish\(\) \{(?P<body>.*?)\n\}", source, re.DOTALL)

        self.assertIsNotNone(finish)
        body = finish.group("body")
        self.assertIn('verify_immutable_binary "$raw_bin" "$raw_bin_sha"', body)
        self.assertIn('verify_immutable_binary "$ffi_dylib" "$ffi_dylib_sha"', body)
        self.assertIn('verify_immutable_binary "$ffi_helper" "$ffi_helper_sha"', body)
        decision = body.index('if [ "$fail" -gt 0 ]')
        self.assertLess(body.index('verify_immutable_binary "$ffi_dylib"'), decision)
        self.assertLess(body.index('verify_immutable_binary "$ffi_helper"'), decision)

    def test_cleanup_recycles_owned_artifact_and_leaves_sibling(self):
        with tempfile.TemporaryDirectory() as root:
            root_path = Path(root)
            artifact = root_path / "artifact"
            artifact.mkdir()
            sibling = root_path / "sibling"
            sibling.mkdir()

            payload = artifact / "evidence.txt"
            payload.write_text("keep me")
            result = self.run_cleanup_helper(
                str(artifact), 'trash() { /bin/mv "$1" "$1.recycled"; }'
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertFalse(artifact.exists())
            self.assertTrue(sibling.is_dir())
            self.assertEqual(
                (root_path / "artifact.recycled" / "evidence.txt").read_text(), "keep me"
            )

    def test_cleanup_refuses_empty_path(self):
        result = self.run_cleanup_helper("")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("refused an empty path", result.stderr)

    def test_cleanup_retains_artifact_without_a_recycle_backend(self):
        with tempfile.TemporaryDirectory() as root:
            artifact = Path(root) / "artifact"
            artifact.mkdir()
            result = self.run_cleanup_helper(str(artifact), 'PATH="/missing-trash-backend"')
            self.assertNotEqual(result.returncode, 0)
            self.assertTrue(artifact.is_dir())
            self.assertIn("retained artifact", result.stderr)

    def run_cleanup_helper(self, artifact: str, backend: str = ""):
        script = f'''
source "{E2E_ROOT / "harness.sh"}"
{backend}
remove_artifact "{artifact}"
'''
        return subprocess.run(
            ["/bin/bash", "-c", script],
            capture_output=True,
            check=False,
            text=True,
        )


ERROR_CODE_SOURCE = E2E_ROOT.parent.parent / "crates" / "core" / "src" / "response" / "error_code.rs"
ERROR_CONTRACT = E2E_ROOT / "scenarios" / "error_contract.sh"
CONTENTION_GUARD = "check_fixture_contention || { finish; exit 1; }"


def core_error_codes():
    return set(re.findall(r'=> "([A-Z_]+)"', ERROR_CODE_SOURCE.read_text()))


def envelope_calls(source):
    return re.findall(
        r'assert_error_envelope\s+"[^"]*"\s+([A-Z_]+)\s+(\S+)\s+(\S+(?:\s+"")?)',
        source,
    )


class ErrorContractLegTests(unittest.TestCase):
    def test_error_contract_runs_after_surfaces_behind_the_contention_guard(self):
        run_source = (E2E_ROOT / "run.sh").read_text()
        surfaces = run_source.index("source \"$here/scenarios/surfaces.sh\"")
        source_line = 'source "$here/scenarios/error_contract.sh"'
        registered = run_source.index(source_line)
        guard = run_source.rindex(CONTENTION_GUARD, 0, registered)
        self.assertLess(surfaces, guard)
        between = run_source[guard + len(CONTENTION_GUARD) : registered].strip().splitlines()
        self.assertEqual(
            between, ["# shellcheck source=tests/e2e/scenarios/error_contract.sh"]
        )
        self.assertLess(registered, run_source.index('source "$here/scenarios/trace_performance.sh"'))
        self.assertLess(registered, run_source.index("cursor-multi-agent-probe.py"))

    def test_error_contract_codes_exist_in_the_core_enum(self):
        known = core_error_codes()
        self.assertIn("INVALID_ARGS", known)
        source = ERROR_CONTRACT.read_text()
        used = {code for code, _, _ in envelope_calls(source)}
        used |= set(re.findall(r'error\.code\)?"?\s*\]?\s*=\s*"([A-Z_]+)"', source))
        self.assertTrue(used)
        self.assertEqual(used - known, set())

    def test_error_contract_leg_uses_exit_code_and_code_together(self):
        calls = envelope_calls(ERROR_CONTRACT.read_text())
        self.assertGreaterEqual(len(calls), 5)
        for code, exit_code, _ in calls:
            self.assertRegex(exit_code, r"^[12]$", code)
        self.assertIn(("INVALID_ARGS", "2"), {(c, e) for c, e, _ in calls})

    def test_batch_leg_pins_continue_and_stop_semantics(self):
        source = ERROR_CONTRACT.read_text()
        self.assertIn('run_timed "$bin" batch "$payload"\n', source)
        self.assertIn('run_timed "$bin" batch "$payload" --stop-on-error', source)
        self.assertIn("data.stopped.reason", source)
        self.assertIn("data.not_started_entries", source)
        self.assertIn("error.details.batch_index", source)
        self.assertIn('json_field "$(get_target "$field" --property value)" data.value', source)

    def test_batch_malformed_run_uses_a_value_the_field_does_not_already_hold(self):
        source = ERROR_CONTRACT.read_text()
        runtime_first = re.findall(r"runtime (\S+)\)", source)
        malformed_first = re.findall(r"malformed (\S+)\)", source)
        self.assertEqual(len(malformed_first), 1)
        self.assertNotIn(malformed_first[0], runtime_first)
        self.assertNotEqual(malformed_first[0], "batch-last")

    def test_no_scenario_forces_a_blocked_combo(self):
        for path in sorted((E2E_ROOT / "scenarios").glob("*.sh")):
            for number, line in enumerate(path.read_text().splitlines(), start=1):
                if re.search(r"\bpress\b", line) and "--force" in line:
                    self.fail(f"{path.name}:{number} presses with --force")

    def run_helpers(self, body: str):
        with tempfile.TemporaryDirectory() as directory:
            mock_bin = Path(directory) / "agent-desktop"
            mock_bin.write_text(
                "#!/bin/sh\n"
                'printf \'%s\' \'{"ok":false,"error":{"code":"INVALID_ARGS",'
                '"disposition":{"delivery":"not_delivered"}}}\'\n'
                "exit 1\n"
            )
            mock_bin.chmod(0o700)
            script = (
                'source "$1"\n'
                'bin="$2"\n'
                f'json_tool="{E2E_ROOT / "json_tool.py"}"\n'
                "pass=0; fail=0; failures=(); skip=0; skips=()\n"
                "okmsg() { pass=$((pass + 1)); }\n"
                "badmsg() { fail=$((fail + 1)); }\n"
                "sleep() { :; }\n" + body + '\nprintf "pass=%s fail=%s" "$pass" "$fail"\n'
            )
            return subprocess.run(
                ["bash", "-c", script, "helpers", str(E2E_ROOT / "lib.sh"), str(mock_bin)],
                capture_output=True,
                check=True,
                text=True,
            ).stdout

    def test_assert_error_envelope_passes_only_when_every_part_matches(self):
        output = self.run_helpers(
            'assert_error_envelope match INVALID_ARGS 1 not_delivered click\n'
            'assert_error_envelope wrong-code ELEMENT_NOT_FOUND 1 not_delivered click\n'
            'assert_error_envelope wrong-exit INVALID_ARGS 2 not_delivered click\n'
            'assert_error_envelope wrong-delivery INVALID_ARGS 1 delivered click\n'
            'assert_error_envelope delivery-unchecked INVALID_ARGS 1 "" click'
        )
        self.assertTrue(output.endswith("pass=2 fail=3"), output)

    def test_await_value_waits_for_the_expected_readout_without_a_fixed_sleep(self):
        output = self.run_helpers(
            'counter="$(mktemp)"; echo 0 > "$counter"\n'
            'find_value() { n=$(<"$counter"); echo $((n + 1)) > "$counter"; '
            '[ "$n" -ge 3 ] && printf done || printf stale; }\n'
            'await_value readout done >/dev/null && echo reached=yes || echo reached=no\n'
            'find_value() { printf stale; }\n'
            'await_value readout done >/dev/null && echo never=yes || echo never=no'
        )
        self.assertIn("reached=yes", output)
        self.assertIn("never=no", output)


SCENARIOS = E2E_ROOT / "scenarios"
KEYBOARD = SCENARIOS / "keyboard.sh"
REF_CHURN = SCENARIOS / "ref_churn.sh"
RELIABILITY = SCENARIOS / "reliability.sh"
INTERACTION = SCENARIOS / "interaction.sh"


def literal_error_codes(source):
    used = {code for code, _, _ in envelope_calls(source)}
    return used | set(re.findall(r'code"?\s*\]?\s*=\s*"([A-Z_]+)"', source))


class KeyboardAndRefChurnLegTests(unittest.TestCase):
    def test_keyboard_runs_after_error_contract_behind_the_contention_guard(self):
        run_source = (E2E_ROOT / "run.sh").read_text()
        error_contract = run_source.index('source "$here/scenarios/error_contract.sh"')
        source_line = 'source "$here/scenarios/keyboard.sh"'
        registered = run_source.index(source_line)
        guard = run_source.rindex(CONTENTION_GUARD, 0, registered)
        self.assertLess(error_contract, guard)
        between = run_source[guard + len(CONTENTION_GUARD) : registered].strip().splitlines()
        self.assertEqual(between, ["# shellcheck source=tests/e2e/scenarios/keyboard.sh"])
        self.assertLess(registered, run_source.index('source "$here/scenarios/trace_performance.sh"'))
        self.assertLess(registered, run_source.index("cursor-multi-agent-probe.py"))

    def test_ref_churn_runs_after_the_probe_on_its_own_fixture_process(self):
        run_source = (E2E_ROOT / "run.sh").read_text()
        probe = run_source.index("cursor-multi-agent-probe.py")
        source_line = 'source "$here/scenarios/ref_churn.sh"'
        registered = run_source.index(source_line)
        self.assertLess(probe, registered)
        self.assertLess(registered, run_source.index("\nfinish", registered))
        preceding = run_source[:registered].rstrip().splitlines()[-2:]
        self.assertEqual(preceding[-1], "# shellcheck source=tests/e2e/scenarios/ref_churn.sh")
        self.assertNotIn(CONTENTION_GUARD, "\n".join(preceding))

    def test_ref_churn_reads_the_fixture_readouts_not_the_command_result(self):
        source = REF_CHURN.read_text()
        self.assertIn('--text "Beta stored: Beta"', source)
        self.assertIn('wait_target "$stable" value 3000 --value stable-ok', source)
        self.assertIn("data.found", source)

    def test_interaction_scroll_asserts_without_a_defect_skip(self):
        source = INTERACTION.read_text()
        self.assertNotIn("skipmsg", source)
        self.assertIn('assert "[$mode] scroll moves content"', source)
        self.assertIn('"$scroll_before" != "$scroll_after"', source)

    def test_unknown_app_skip_is_gated_on_the_duplicate_pid_inventory_signature(self):
        source = ERROR_CONTRACT.read_text()
        self.assertIn('[ "$(json_field "$1" "$2.code")" = "TIMEOUT" ]', source)
        self.assertIn('= "global_window_inventory_unstable" ]', source)
        self.assertIn('"$2.details.skipped.0.field")" = "duplicate_pid" ]', source)
        self.assertIn("crates/macos/src/system/appkit_bridge.m", source)
        self.assertIn(
            'assert_error_envelope "unknown app is APP_NOT_FOUND" APP_NOT_FOUND 1 not_delivered',
            source,
        )
        self.assertIn('inventory_duplicate_pid_refusal "$RUN_JSON" data.results.1.error', source)

    def test_removed_element_leg_accepts_only_stale_ref_not_delivered(self):
        source = RELIABILITY.read_text()
        self.assertNotIn("STALE_REF|TIMEOUT", source)
        self.assertIn('"$stale_code" = "STALE_REF"', source)
        self.assertIn('"$stale_delivery" = "not_delivered"', source)
        self.assertIn('"$row_gone" = "1"', source)

    def test_new_legs_use_error_codes_that_exist_in_the_core_enum(self):
        known = core_error_codes()
        for path in (KEYBOARD, REF_CHURN, RELIABILITY):
            used = literal_error_codes(path.read_text())
            self.assertEqual(used - known, set(), path.name)
        self.assertIn("STALE_REF", literal_error_codes(REF_CHURN.read_text()))
        self.assertIn("STALE_REF", literal_error_codes(RELIABILITY.read_text()))
        self.assertEqual(
            literal_error_codes(KEYBOARD.read_text()), {"POLICY_DENIED", "INVALID_ARGS"}
        )

    def test_press_scenario_observes_the_field_not_the_command(self):
        source = KEYBOARD.read_text()
        self.assertIn("await_value text-echo", source)
        self.assertIn('"$observed" = "$expected"', source)
        self.assertIn("press cmd+a", source)
        self.assertIn('press_expect "press cmd+a then delete empties the field" delete ""', source)
        self.assertIn("POLICY_DENIED 1 not_delivered", source)
        self.assertIn("INVALID_ARGS 1 not_delivered", source)


if __name__ == "__main__":
    unittest.main()
