# Linux live end-to-end harness

Drives the built `agent-desktop` binary against real GNOME and Qt applications inside private, throwaway desktop sessions. Every effect is verified by an independent read (raw AT-SPI, X11, GSettings, process, pixel, clipboard or D-Bus), never by the command's own `ok:true`.

## Run

Build the CLI and its adjacent clipboard owner and run one tier in one call:

```sh
bash tests/e2e-linux/run.sh --tier x11-openbox
```

Each run builds (`cargo build --locked --release`) into its own suite's temporary Cargo target, stages both executables in `<suite>/bin/`, and records their SHA256s in adjacent `.sha256` files and in the startup `image:` lines. It then removes the build intermediates. Every leg uses that pinned pair. A staged hash mismatch fails the run, and other worktrees' builds cannot replace either image. An externally supplied `AGENT_DESKTOP_E2E_BIN` (or `AGENT_DESKTOP_E2E_BIN_SRC`) skips the build and freezes that image and its adjacent helper before the interaction lease is taken.

Omit `--tier` to run all tiers sequentially. Set `AGENT_DESKTOP_E2E_SUITE` to a fresh directory to choose the evidence location. The default is a fresh directory under `$AGENT_DESKTOP_SESSION_BASE` when nonempty, otherwise `$XDG_RUNTIME_DIR/agent-desktop-sessions` when `XDG_RUNTIME_DIR` is nonempty, otherwise `/tmp/agent-desktop-sessions-<uid>` with the numeric user ID. The base is created with mode 0700. The runner starts its own private sessions and takes the interaction lease.

Exit codes: `0` every leg passed or asserted its refusal; `1` any other outcome (see Outcomes); `2` the gate refused to start (missing prerequisite, unknown leg, leg not registered for the tier, staging failure, or the interaction lease is already held). Nothing ran on exit 2.

Keep failed suites for diagnosis; the runner removes a successful suite. Use another fresh suite for the sole diagnostic rerun. Do not reuse a suite with a different binary image.

### Prerequisites

`runner/gate.py` is the authoritative list; a missing item exits 2 before any leg runs.

- Python 3 with PyGObject (`import gi`).
- Base tools: `Xvfb`, `dbus-daemon`, `dbus-update-activation-environment`, `gdbus`, `busctl`, `gsettings`, `setsid`, `xprop`, `xwininfo`, `xwd`, `fusermount`, `timeout`.
- `x11-openbox`: `xdotool`, `wmctrl`, `xclip`, and the openbox binary at `$AGENT_DESKTOP_WM_ROOT/usr/bin/openbox` (`AGENT_DESKTOP_WM_ROOT` defaults to `/`).
- `x11-mutter`: `gnome-shell`, `xdotool`, `wmctrl`, `xclip`.
- `wayland`: `gnome-shell`, `wl-copy`, `wl-paste`.
- The legs also drive the GNOME apps Calculator, Text Editor, Files, Terminal and Settings, and a PyQt6 test window. AT-SPI must be available in the private session.

The runner inherits the caller's tool paths and libraries: supply tools through `PATH` and shared libraries through `LD_LIBRARY_PATH`. Qt legs run under `python3`; set `AGENT_DESKTOP_QT_PYTHON` when PyQt6 lives in a separate interpreter. That does not change the harness interpreter.

## Tiers

- `--tier x11-openbox`: private Xvfb and openbox.
- `--tier x11-mutter`: private Xvfb and the private mutter shell wrapper.
- `--tier wayland`: private bus and a health-gated headless GNOME Wayland shell.

Each tier runs the headless and headed modes registered for that leg. A headed mode on a headless compositor sends synthetic input inside that private session, not to the user's desktop.

`events.open_and_close_inside_one_wait` and `ref_actions.drag` are registered on openbox only. On Mutter, the first leg tore down against a vanished AT-SPI node. The second timed out during editor registry setup before it dispatched a product command. Neither counts as a Mutter pass. A leg that is not registered for a tier makes no live claim there.

## Legs

Use `--leg <id>` with the same tier to reproduce a single registered leg:

```sh
bash tests/e2e-linux/run.sh --tier x11-openbox --leg clipboard.text_roundtrip
```

`runner/legs.py` is the inventory of IDs, tiers, modes, oracles and dispositions. Pass `--leg id1,id2,id3` to run a bounded batch in one private tier session. Every requested ID must be registered for the selected tier; a mismatch exits 2. A single ID executes all its registered modes; it is not a mode selector.

A pass requires independent before/after observations, restoration where state changed, and the same attributed app process generations after cleanup. A refusal leg must assert its expected error and absence of effect.

Per-leg cleanup stops each attributed app generation. Private background services may start or exit independently; their membership does not show an app leak. Private-session teardown sweeps all runtime members and fails if any survive.

To list registered IDs, modes and dispositions for a tier without starting apps:

```sh
python3 -I - <<'PYLIST'
import sys
sys.path.insert(0, "tests/e2e-linux")
from runner.legs import REGISTRY
for leg in REGISTRY:
    if "x11-openbox" in leg.tiers:
        print(leg.id, ",".join(leg.modes), leg.disposition, leg.reason)
PYLIST
```

Change the tier string to `x11-mutter` or `wayland` for those inventories.

### Outcomes

The report groups outcomes by tier and mode. Only `pass` and `asserted-refusal` exit 0.

| Outcome | Meaning |
| --- | --- |
| `pass` | Every before, after and restored read agreed and the owned process set was unchanged. |
| `asserted-refusal` | The leg's expected result is the product's refusal with a named error code and no effect; it was observed. |
| `fail` | An assertion failed, an oracle read was missing or out of order, state drifted and was not restored, or the owned process set changed. |
| `error` | An unexpected exception, an evidence write failure, a changed staged binary, or a teardown failure. |
| `blocked` | The leg raised `NotImplementedError`. |
| `unimplemented` | The leg is registered but has no implementation. |
| `outstanding`, `owner-decision` | Registered but deliberately not run; the reason is printed. |
| `tier-unavailable` | The tier's private session never became healthy or its desktop warm-up failed, so its legs did not run. |

The `launch.recovery_strategy_on_error` leg is an `asserted-refusal`. It stops Calculator after a snapshot, then requires a click on the dead owner's ref to answer `STALE_REF` with `details.process_state=exited`, `details.retryable=false` and disposition `not_delivered`/`safe`, with no `recovery` object and no relaunch of the owner.

The `error_contract.recoverable_error_envelopes` leg is an `asserted-refusal` on both X11 tiers. Against a live Calculator it requires a bare `@e1` to answer `INVALID_ARGS` with the snapshot-qualified suggestion, `@sdeadbeef:e1` to answer `SNAPSHOT_NOT_FOUND` with the `refresh_snapshot_then_retry_original` recovery, and an unknown `--app` to answer `APP_NOT_FOUND` with the `list-apps` suggestion. Each must be `not_delivered` and exit 1, and the Calculator display and the owned-process set must be unchanged.

The `observation.stale_ref_after_ui_change` leg is an `asserted-refusal` on both X11 tiers. It mints a ref to the Calculator About menu item, closes the menu through the raw toggle, and requires `click` on that ref to answer `STALE_REF` with the `refresh_snapshot_then_retry_original` recovery, `not_delivered` and exit 1 while the app stays owned and the display is unchanged; a fresh snapshot must then mint a different ref.

The `text_entry.press_combos_edit_document` leg runs headed on both X11 tiers: after a semantic `type`, `press return` must add exactly one newline to the AT-SPI document text, `press ctrl+a` then `press backspace` must empty it, and no X11 modifier may stay down. A headless `press` is refused by the physical-input policy before any key is sent, so only the headed run proves delivery.

The `batch_contract.entry_failure_and_stop_on_error` leg is an `asserted-refusal` on both X11 tiers. A three-entry batch (click 7, click an absent ref, click 8) must report `STALE_REF` on entry 1 inside an `ok` batch envelope and still run entry 2, leaving `78` on the Calculator display. The same batch with `--stop-on-error` must report `stopped` as `stop_on_error` at index 1 with two completed entries and one not started, leaving `7`. The display is read through AT-SPI, not the envelope, and Undo restores it.

### Ref-action contracts

The `ref_actions.*` legs observe and restore native application state:

| Action | Independent effect |
| --- | --- |
| Focus | Qt Text entry gains `FOCUSED`; the prior button regains it on restoration. |
| Double-click / triple-click | Text Editor selects a word / line, read through AT-SPI Text selection offsets. |
| Right-click | Text Editor exposes a showing `Context menu` and its menu-item children. |
| Hover | The Qt probe's native status tip appears and clears when the pointer leaves. |
| Expand / collapse | Calculator's Main Menu changes `EXPANDED` and showing menu children together. |
| Scroll | Settings Hot Corner leaves the viewport and Dynamic Workspaces enters it. |
| Scroll-to | Settings reveals the offscreen monitor checkbox without changing its checked state. |
| Drag | Text Editor gains a nonempty text selection. |

Headless focus, double-click, triple-click, hover, scroll and drag are separate `asserted-refusal` legs requiring `POLICY_DENIED`, no app effect and unchanged pointer and focus. Right-click, expand/collapse and scroll-to have semantic success legs in both modes. The `pointer.*` legs compare the product's delivery report with an independent read of the app state, in both delivered and undelivered cases. A fabricated report or pointer movement alone cannot pass. The `mouse-click`, `drag` and `mouse-wheel` delivery legs read the actual effect: the Calculator digit, the Text Editor selection or the scrollbar position. Text Editor is seeded in memory through raw `EditableText`, and selection cleanup sends Right only after requiring that the exact owned window is active.

### Notification and tray legs

Notification legs (`notifications.*`) run on `x11-mutter`, where the private GNOME shell owns the notification server; `oracle/notify.py` checks that the server's process belongs to the private runtime directory. A separate sender process posts notifications, and a `dbus-monitor` records the daemon's signals in `notification-signals.log`. A leg passes on the sender's IDs, those signals and the list readback, and closes every owned ID with restoration checked before the next leg.

- Headless `dismiss-notification`, `dismiss-all-notifications` and `notification-action` must answer `POLICY_DENIED`, with no daemon signal and an unchanged list.
- `notifications.dismiss_notification_closes_only_target` is headed. It seeds a target and a bystander, requires a wrong `--expected-app` to answer `NOTIFICATION_NOT_FOUND` with no signal and no list change, then requires only the target's daemon close (reason 2), the bystander still active, and a list containing only the bystander.

Tray legs (`tray.*`, `x11-mutter`, headless) register a harness StatusNotifierItem (`apps/sni_item.py`) and read its call log: `Activate`, menu `Event(id, clicked)`, the refusal for an item without `Activate`, and a killed owner turning the old ref into `STALE_REF`.

### Coverage boundaries

The registry is the inventory; these surfaces have no live claim, and their coverage lives in the named tests.

- Electron and Chromium: no leg in this registry.
- Clipboard HTML import: unsupported by design. `clipboard-get` reads only the text and image targets (`formats::TEXT_TARGETS`, `targets::choose_target`; `x11_read_tests::an_owner_without_the_wanted_target_reads_as_absent`). The clipboard legs cover text, image, owner lifetime, clear and a foreign read after the CLI exited.
- Positive `select` on a display value: only `select.refusal_without_semantic_route` is live. `crates/linux/src/actions/select/select_tests.rs` and `select_search_tests.rs` cover route, identity, effect and refusal.
- Wayland: the private shell has no keyboard seat, so focus and window capture are live only as fail-closed refusals (`wayland_actions.*`, `gaps.wayland_window_capture_refused`). The other Wayland legs check that `list-windows` reports no position, that a seatless semantic click works, and that an unhealthy shell fails the tier with a named reason.

## Reading a failure

The printed report groups every outcome by tier and mode. Failed runs retain `report.txt` and per-leg JSON evidence in the printed suite directory. Evidence includes product argv, response envelopes, oracle reads, and process membership. Read `report.txt` first, then pretty-print the matching `evidence/<tier>/<mode>/<leg-id>.json` with `python3 -m json.tool`. Its `exception_traceback`, `products`, `reads`, and `owned_baseline`/`owned_final` show whether failure occurred before dispatch, at the effect check, or during restoration. A matching deterministic product failure needs the same command, preconditions and independent effect/no-effect reads on the diagnostic rerun. A raw-bus, launch, timing or service-membership failure before product dispatch is a fixture/environment failure; preserve its evidence when retiring it.

Rerun a failed leg at most once to distinguish a deterministic product defect from timing, load, session setup, or environment behavior. Delete an unstable leg or replace it with a deterministic fake or an observed-state wait, and record the reason in a `test:` commit. Fix product code only for a deterministic product defect, especially wrong-target input or false delivery evidence.

### Negative control

`--lying-actions` replaces the CLI with a fake that always answers `ok:true` without real refs or effects, so any selection must fail. It may fail at ref acquisition before an action; portable lying-effect tests separately exercise the effect and restoration checks. Run this expected failure locally with a fresh suite:

```sh
bash tests/e2e-linux/run.sh --tier x11-openbox --leg state.text_editor_semantic_type --lying-actions
```

The prerequisite gate still requires an existing release binary path (`AGENT_DESKTOP_E2E_BIN`, `AGENT_DESKTOP_E2E_BIN_SRC`, or `target/release/agent-desktop`); the fake replaces it after the gate passes. The negative control does not prove cleanup; that is the cancellation check below.

### Cancellation check

At startup the runner prints `suite:` and both `image:` hashes. When a private tier's accessibility health gate passes, it atomically publishes `<suite>/<tier>.ready.json` and prints `cancel-ready:` with that path, the runtime directory, `harness-owner` marker, runner PID and Linux `/proc` start token (field 22, ticks since boot). The marker contains `<pid> <start-token>`. The background shell/interaction-lock wrapper PID is not the runner PID.

This bounded check waits for the receipt rather than guessing a PID or sleeping before a signal:

```sh
export CARGO_INCREMENTAL=0
base=${AGENT_DESKTOP_SESSION_BASE:-${XDG_RUNTIME_DIR:+$XDG_RUNTIME_DIR/agent-desktop-sessions}}
base=${base:-/tmp/agent-desktop-sessions-$(id -u)}
umask 077
mkdir -p "$base"
suite=$(mktemp -d "$base/e2e-cancel.XXXXXX")
AGENT_DESKTOP_E2E_SUITE="$suite" bash tests/e2e-linux/run.sh \
  --tier x11-mutter --leg ref_actions.right_click >"$suite/run.log" 2>&1 &
job=$!
python3 -I tests/e2e-linux/runner/cancel.py "$suite/x11-mutter.ready.json" --wait 600
signal_rc=$?
wait "$job"; rc=$?
cat "$suite/run.log"
test "$signal_rc" -eq 0 && test "$rc" -eq 143 || exit 1
python3 -I tests/e2e-linux/runner/cancel.py "$suite/x11-mutter.ready.json" \
  --check-cleanup --wait 60
```

`cancel.py` checks the marker, exact `runner/main.py` command, user and start token before sending SIGTERM through a Linux PID descriptor. A changed or exited generation is refused. The final check waits until the runtime directory is absent and no process environment references it. Run these commands together in one local shell. The next run sweeps abandoned sessions whose recorded runner has exited.

## Portable self-tests

These need no Linux session. `AGENT_DESKTOP_E2E_SKIP_LIVE=1` skips the checks that need a live session, as CI does:

```sh
AGENT_DESKTOP_E2E_SKIP_LIVE=1 python3 -I -m unittest discover -s tests/e2e-linux -p 'test_*.py'
python3 -I -m unittest discover -s tests/e2e -p 'test_*.py'
```

## KDE manual matrix

The runner hosts GNOME sessions only. The same surface is walked by hand on a real KDE Plasma desktop. The table is an acceptance checklist, not copy/paste shell commands: choose concrete apps and refs and record the setup. Use the `agent-desktop` executable prefix for every product command. Pointer, drag and notification mutation commands require global `--headed`; `dismiss-notification` and `notification-action` also require a fingerprint from the same listing (`--expected-app` or `--expected-title`). The `_NET_ACTIVE_WINDOW` oracle applies to X11 only; Wayland uses independent raw window ACTIVE/focus reads and exact documented refusal outcomes.

One row per cell; a cell that cannot run on the session is written down with its reason, never left blank.

| Area | Steps | Expected shape | Record |
| --- | --- | --- | --- |
| Snapshot | `snapshot --app <app> -i` on a Plasma window | refs allocated, `complete: true` | pass / finding with the raw tree |
| Semantic click | `click <ref>` on a Plasma button | the button's own effect, read back from the app | pass / finding |
| Wheel and drag | `mouse-wheel` and `drag` over a Plasma window | pointer moves and the app reacts | pass / finding |
| Focus | `focus-window` on a covered Plasma window | `_NET_ACTIVE_WINDOW` names the target | outcome set, not a single value |
| Notifications | `list-notifications` after `notify-send` | the sender's summary appears once | pass / finding |
| Dismiss | `dismiss-notification 1 --expected-app <app>` | the banner is gone and no other banner moved | pass / finding |
| Tray | `snapshot --surface system-tray` with an SNI item registered | the item is listed and `click` reaches `Activate` | pass / finding |
| Menu surface | open a Plasma menu, `snapshot --surface menu` | item count equals the raw showing count | pass / finding |
| Wayland | repeat Snapshot, Semantic click and Focus under Plasma Wayland | focus refusals match the landed X11/Wayland decision | pass / finding |
