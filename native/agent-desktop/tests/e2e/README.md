# Native macOS end-to-end tests

This suite drives the release `agent-desktop` binary against a real macOS app
and verifies effects through independent accessibility observations. A command
returning `ok: true` is never sufficient when the fixture exposes an observable
status, value, process, window, or surface transition.

## Run the fixture suite

```bash
AGENT_DESKTOP_E2E_EXCLUSIVE=1 bash tests/e2e/run.sh
```

The single prerequisite gate requires:

- macOS;
- Accessibility permission granted to the terminal or runner; and
- a buildable Swift fixture app.

`AGENT_DESKTOP_E2E_EXCLUSIVE=1` is a safety acknowledgement that the caller has
made the desktop exclusive, including stopping user input and other automation.
The harness lock prevents a second native harness from starting, but it cannot
stop an unrelated `agent-desktop` process from starting between commands. Do
not set the acknowledgement while the desktop is in use.

Before taking the desktop lock, `run.sh` builds the CLI, macOS helper, and FFI
library from the current checkout with `--locked` into the canonical repository
`target` directory. It then hashes and copies those exact artifacts to read-only
paths under a private suite directory. The suite uses only those copies plus an
isolated `HOME`, ref/session stores, fixture build, and `TMPDIR`. Every CLI child
runs in its own process group with an absolute timeout and bounded stdout/stderr
capture. The JSON `version` and the Clap `--version` output must both match
`Cargo.toml` before the first scenario runs, and the artifact hashes are verified
again before success is reported.

Before the fixture suite starts, `run.sh` runs `safe-semantic.sh`, a strict
headless non-interference gate. It launches the fixture in the background and
asserts that semantic click, type, set-value, and check/uncheck/toggle commands
each produce their effect while the fixture never becomes frontmost. Its exit
code (`1` failure, `2` blocked prerequisite) ends the run before any headed case.

The harness then builds and launches `AgentDeskFixture.app`. Once the fixture is
running, a missing control, window, status readout, bounds record, or surface is
a test failure. Scenarios never turn a missing prerequisite into a successful
`SKIP`. Exit `0` means every assertion passed from an uncontaminated run, exit
`1` means a behavioral failure, and exit `2` means the global prerequisite gate
failed.

Headed cases move the real cursor. Run them on a machine where that is safe.
The fixture process is force-closed by the cleanup trap even when a test fails.
After the scenarios, `run.sh` closes the fixture and runs
`scripts/cursor-multi-agent-probe.py` in headless and headed modes.

For a dedicated self-hosted runner, `scripts/run-native-e2e-ci.sh` sets the
exclusivity acknowledgement and calls `run.sh`; it refuses to run unless
`AGENT_DESKTOP_NATIVE_E2E_RUNNER=1` is set. The `native-e2e.yml` workflow is
`workflow_dispatch` only.

## Exact ref namespaces

Every non-count `find` returns two inseparable values:

```json
{"ref_id":"@s8f3k2p9:e12","snapshot_id":"s8f3k2p9"}
```

`lib.sh` carries that pair as one target and every ref action, `get`, `is`, and
element `wait` passes the qualified ref, which embeds its snapshot. The harness
deliberately runs unrelated observations between `find` and `get` to prove that
a ref does not depend on the mutable latest-snapshot pointer. Do not add a
helper that returns a bare `@eN`.

## Layout

| Path | Responsibility |
|---|---|
| `run.sh` | Global gate, fixture lifecycle, semantic suite orchestration |
| `harness.sh` | Exclusivity acknowledgement, isolated `HOME`/`TMPDIR`, immutable binary and FFI staging |
| `lib.sh` | Fail-closed assertions and exact `{ref_id,snapshot_id}` target helpers |
| `safe-semantic.sh`, `scenarios/silent-text.sh`, `safe_semantic_guard.py` | Strict headless non-interference gate that runs before the fixture suite |
| `scenarios/observation.sh` | Snapshots, locators, namespace pinning, strict twins |
| `scenarios/interaction.sh` | Headless/headed actions and exact-once effects |
| `scenarios/acceptance.sh` | Named AE1-AE7 acceptance contract |
| `scenarios/reliability.sh` | Stale refs, waits, drill-down, sessions |
| `scenarios/surfaces.sh` | Sheets, menus, drag, disclosure |
| `scenarios/error_contract.sh` | Exit code and `error.code` envelopes an agent branches on, `batch` continue/stop/reject semantics |
| `scenarios/keyboard.sh` | `press` key combos observed through the fixture's own text readout, blocked-combo and unknown-modifier refusals |
| `scenarios/trace_performance.sh` | Trace artifacts, redaction, timings, cleanup |
| `scenarios/ref_churn.sh` | `STALE_REF` after the UI really changes, on a dedicated fixture process (`AGENT_DESKTOP_FIXTURE_REF_CHURN=1`), with and without the opt-in command host |
| `scenarios/notifications.sh` | Real Notification Center lifecycle |
| `permission-contract.sh` | Deterministic AE5 mapping tests without mutating TCC |
| `electron-live.sh`, `electron_metrics*.py` | Opt-in installed Electron/Chromium app measurement |
| `json_tool.py`, `bounded_process.py`, `guard-command.sh` | JSON field extraction and the timeout/output-capped, process-group-isolated command runner |
| `interaction_lock.py` | Exclusive desktop lease held by `run.sh`, `safe-semantic.sh`, and `electron-live.sh` |
| `ffi_live.py` | Native release-FFI consumer used by AE2 |
| `test_*.py` | Desktop-free unit tests for the harness itself |

Keep every shell file under 400 lines (the repository's file-size convention;
`scripts/check-rust-file-size.sh` enforces the cap for `.rs` files only) and
Bash 3 compatible (macOS ships Bash 3); `scripts/check-bash3-compat.sh` gates
the top-level `tests/e2e/*.sh` files.

The harness self-tests need no desktop and run in the `fmt` CI lane:

```bash
python3 -m unittest discover -s tests/e2e -p 'test_*.py'
```

## AE1-AE7 acceptance map

`scenarios/acceptance.sh` names and fails closed on every acceptance example:

| Example | Native fixture assertion |
|---|---|
| AE1 | An addressable button whose live AX frame is zero reports `visible=false`. |
| AE2 | CLI and native release-FFI consumers wait for a button enabled after 800 ms, dispatch exactly once, and perform one immediate check under timeout zero without a late effect. |
| AE3 | A permanently disabled button with `--timeout-ms 2000` returns `TIMEOUT`, `details.kind=actionability_timeout`, and `details.last_report` near 2 s. |
| AE4 | Two windows with the same title receive distinct ids; focusing the second id focuses that exact window. |
| AE5 | Deterministic tests prove prompt isolation and nonprompting Automation probes; when the runner already has denied Automation TCC, a native headed Notification Center operation must return `PERM_DENIED`. Other TCC states are explicitly logged as unavailable rather than claimed as exercised. |
| AE6 | One batch captures a pre-action baseline, clicks open a sheet, and reports `surface_appeared` without naming the surface title. |
| AE7 | The same disabled action with no timeout flag returns the structured timeout near the untouched 5 s default. |

AE2, AE3, and AE7 run in both headless and headed policy modes. Elapsed-time
tolerances account for process launch and scheduler noise but are narrow enough
to detect a missing wait, the wrong default, or an unbounded overrun. Delayed
action status is observed after a settle interval so a duplicate late dispatch
cannot pass.

`permission-contract.sh` is intentionally deterministic. It tests the expired
deadline, helper result, and Automation-not-required contracts without calling
native prompt APIs, resetting TCC, or assuming the developer's consent state.

## Installed Electron/Chromium measurement

The live harness is opt-in and is never called by `run.sh` or unprivileged CI:

```bash
AGENT_DESKTOP_E2E_EXCLUSIVE=1 bash tests/e2e/electron-live.sh --app Slack
AGENT_DESKTOP_E2E_EXCLUSIVE=1 bash tests/e2e/electron-live.sh \
  --app "Visual Studio Code" \
  --baseline-binary /path/to/previous/agent-desktop \
  --out /tmp/vscode-ax.json
```

The app must already be installed, running, and exposing at least one window.
The harness does not launch, focus, click, type into, or close the user's app.
If any prerequisite is unavailable, invocation fails instead of emitting a
successful partial benchmark.

It performs exactly five warmup pairs and 31 measured release-binary pairs of
`find --role button --first`. When `--baseline-binary` is supplied, immutable
baseline (A) and current (B) binaries run in balanced AB/BA order against one
exact process generation and window inventory, with separate `HOME`
directories. State is checked before and after every pair. The v3 JSON schema
includes nearest-rank wall and CPU p50/p95, paired current-minus-baseline
deltas, success and correctness rates, AX traversal/read statistics when a
binary emits them, renderer activation counts, SHA-256/version identities, raw
samples, and exact-snapshot re-resolution checks. It deliberately omits RSS:
`RUSAGE_CHILDREN.ru_maxrss` is a cumulative harness maximum, not a per-command
measurement.

The report labels its limits: it describes one machine, app state,
and TCC state; it measures observation and ref re-resolution rather than action
delivery; and it never invents a baseline when none was explicitly supplied.
The default output is a timestamped file under `/tmp`; pass `--out` to retain it
elsewhere.

## Adding a scenario

1. Add a stable accessibility label and an independently observable status to
   the fixture.
2. Resolve action targets with `require_target`; never retain a bare ref.
3. Use `act_target`, `get_target`, `is_target`, or `wait_target` so the source
   snapshot id is always explicit.
4. Treat missing controls and unsupported behavior as failures after setup.
5. For timing behavior, assert both the structured JSON contract and elapsed
   bounds, then verify that no duplicate effect appears after settling.
6. Source the new scenario file from `run.sh`, after the existing scenarios and
   guarded by `check_fixture_contention`.
