# Numbers model-facing reliability evaluation

Use the public Agent Desktop CLI directly. The model must read the original JSON
and select refs itself. Do not insert Python/jq tree extraction, a custom ref
picker, raw AX mutations, or AppleScript into the evaluated interaction workflow.

The required task outcomes and gates are frozen in [acceptance v1](acceptance-v1.md),
which excludes the Numbers cases (N1-N8) from active qualification; the Numbers
protocol below stays the reproducible way to run them. Fixture tests provide
deterministic regressions, not proof of Numbers task completion.

## Ownership and evidence

Use an immutable release binary, an isolated absolute `AGENT_DESKTOP_HOME`, and
an owned document named `AD Reliability.numbers`. Record binary/diff hashes,
macOS/Numbers versions, seed contents, permissions and process/window identity.
Never activate the app or touch another document. Preserve original command
output; shell `tee` is acceptable, filtering responses for the model is not.

Setup and independent verification are separate from task execution. Prepare
Sheet 1 / Eval Grid with B2=`seed-target`, C2=`neighbor-guard`, B3=17, C3=25,
eight rows and five columns. For the duplicate-table case, prepare Eval Other /
Eval Grid with B2=`other-sheet-guard`. Native document scripting may prepare
these seeds without activation, but cannot count as a completed CLI task.
Wait for window readiness after asynchronous setup.

## Model tasks

1. Discover the grid through `list-windows`, `snapshot --window-id ... --skeleton
   -i --compact`, and `snapshot --root ...`. Choose refs from those outputs.
2. Select B2, discover the editor, replace its contents, and commit semantically.
   Independently verify the exact cell and unchanged neighbor.
3. Read the original cell ref after entering edit mode. Record automatic
   recovery, stale refusal, or incorrect targeting separately.
4. Switch sheets by ref. Compare `get --property states`, `get --property value`,
   and `is --property checked` on the same ref with the actual active sheet.
5. Change Number of rows from eight to nine and back using the original ref.
   Compare CLI reads with independently queried document dimensions.
6. Enter a formula, save, close, and reopen through supported semantic commands.
   If an earlier step is blocked, report the dependent task uncompleted. Do not
   fill or save through scripting and count it as Agent Desktop success.

Retain every attempt, expected/actual effect, original output, latency and
headless evidence. Distinguish task failure, safe refusal, native limitations,
environmental interference and not-run cases. A later success does not erase a
failure. Endpoint pointer equality alone is insufficient side-effect evidence.

## Independent raw AX diagnosis

`ax_probe.swift` is a diagnostic helper, not the model's driver. It reads native
attributes/actions/settable flags through ApplicationServices without Agent
Desktop internals. It requires the process ID and an exact owned window title
that starts with `AD Reliability`. It also lists parameterized attribute names
and reads AXIdentifier and AXDOMIdentifier. Inspect parameterized attributes
before concluding that an editor exposes no write path. Ordinary setters
can be no-ops while the element still advertises an operation such as
`AXReplaceRangeWithText` (Numbers' cell editor advertises AXStringForRange,
AXAttributedStringForRange, AXLineForIndex, AXReplaceRangeWithText,
AXBoundsForRange and AXRangeForLine).

Compile with `swiftc tests/real-apps/ax_probe.swift -o /tmp/ad-ax-probe`. Examples:

```
/tmp/ad-ax-probe PID 'AD Reliability.numbers' inspect 'seed-target'
/tmp/ad-ax-probe PID 'AD Reliability.numbers' inspect editor
```

Reserve `press`, `select`, and `set` for separate raw AX trials on equivalent
clean starting states. Never use them to rescue the CLI workflow or blindly
repeat an uncertain action. Native success alone is not proof of effect. These
operations target one `AXCell` or `AXMenuButton` by exact title or description;
`select` is Numbers-specific and writes `AXSelectedCells` on the `AXTable` whose
title contains `Eval Grid`.

## Repeat sheet transitions without response rewriting

Read `find --window-id ... --role radiobutton` yourself and choose the two
sheet refs from its original response. With the owned document and correct
state namespace, run:

```
bash tests/real-apps/numbers-sheets.sh /absolute/candidate w-123 @snapshot:e1 @snapshot:e2 5
```

The arguments are `BINARY` (absolute path), `WINDOW_ID`, `SHEET_1_REF`,
`OTHER_SHEET_REF`, and an optional `CYCLES` (default 5, at most 15). The
environment must set `AGENT_DESKTOP_HOME` to an absolute path. Use actual
qualified refs, not the placeholders above. Start with Eval Other active so the
first click is a transition. The script reuses the same refs for two
transitions per cycle, prints unchanged JSON and saves it with the screenshots
under the `/tmp/ad-numbers-sheets.*` evidence directory it announces, captures
every transition, and waits for both selected and unselected values. Any
command failure stops the run; a failed click gets a diagnostic screenshot but
is never retried. It performs no setup, response parsing, app activation or
physical input.

Completion is not a passing score: inspect every `get`/`is` pair and screenshot,
and independently verify active sheet and unchanged guard cells. Reset and
rediscover refs between acceptance batches. Retain failed attempts. The runner
does not verify continuous foreground/pointer stability or document persistence.
Its failure-stop check is `python3 tests/real-apps/numbers_sheets_test.py`.

## Parameterized replacement differential

`replace_contract_fixture.m` and `replace_range_probe.swift` are separate raw AX
diagnostics, not an Agent Desktop acceptance driver. Compile with:

```
clang -framework AppKit tests/real-apps/replace_contract_fixture.m -o /tmp/ad-replace-fixture
swiftc -module-cache-path /tmp/ad-swift-cache tests/real-apps/replace_range_probe.swift -o /tmp/ad-replace-probe
```

Run `/tmp/ad-replace-fixture` for the custom receiver or add `--standard` for
plain NSTextView. `--standard-focused` additionally assigns the text view as
the window's internal first responder and logs input-context state without
activating the app or making the window key. These modes create an owned
background window and print their PID.
In a separate process, use the printed PID:

```
/tmp/ad-replace-probe PID 'AD Reliability Parameter Contract' seed-target replacement-token
```

The probe requires the exact owned window and one AXTextArea with the expected
seed value, checks advertised support, and refuses a foreground target. It
dispatches once and exits 1 when AX fails or readback differs from the requested
replacement. It does not retry, commit or prove continuous headless operation.
Close only the printed fixture PID with `kill -TERM PID` after the test. A
successful custom receiver proves parameter transport; it does not prove that
AppKit's default receiver or Numbers can perform the operation in the background.
The cross-process argument is a dictionary: `AXReplacementRange` (an AXValue
CFRange in UTF-16 units) and `AXReplacementText` (a CFString), read by AppKit's
`_NSAccessibilityResultForReplaceRangeWithText`. Native success plus `true` does
not mean the text changed. Plain background NSTextView (`--standard`) and Numbers
both return them and leave the value unchanged; only the custom receiver changes it.
A surrogate-pair check replacing `A😀B` logged UTF-16 range `{0, 4}`.
AppKit's default path goes through the current input context. That context is nil
for a non-key window, even after the text view becomes first responder (`--standard-focused`).
No production write path uses this operation: no Numbers background write was shown to work.

## Nested scroll regression

Compile `nested_scroll_fixture.m` with
`clang -framework AppKit tests/real-apps/nested_scroll_fixture.m -o /tmp/ad-nested-scroll-fixture`
and launch the resulting executable directly. It creates only an owned
background window named AD Reliability Nested Scroll. Discover that window and the Clipped target ref
through the public CLI. Capture a window screenshot before and after `scroll-to`
on the discovered ref. Before, the button is outside its scroll viewport but
inside its window; after, the button must actually be visible. Merely returning
`verified: true` or reading window-relative offscreen state is not a valid oracle:
the failure this regression guards against is a verified skipped step that moves
nothing. Record original command output and inspect both screenshots.
Close only the fixture's printed PID with `kill -TERM PID` after the trial.

## Additional Xcode coverage

The second-app probe uses only an owned `AD Reliability.swift` file in
background Xcode (the raw AX helper rejects windows whose title does not start
with `AD Reliability`). Discover Source Editor through skeleton/root, replace its
value, insert text on the same ref, and verify screenshots plus exact disk
contents. Closing by the original Close ref and reopening as separate setup
checks persistence; do not count setup as CLI task completion. Preserve rejected
old-window refs and native menu failures alongside successful editing.

The raw AX helper can inspect controls by exact title or description and invoke
`press` or `show-menu` on an owned AXMenuButton for separate diagnostic trials.
It records foreground endpoints, not continuous monitoring. An uncertain native
return never authorizes a fallback action or automatic replay.

## Observe headless side effects during a trial

Compile it with `swiftc tests/real-apps/headless_probe.swift -o /tmp/ad-headless-probe`,
then run `/tmp/ad-headless-probe PID 60` (running target PID, then a duration of
up to 300 seconds) in a separate terminal/process. Start evaluated commands
only after its original JSON reports `event: ready`. It observes workspace
activation notifications, session-wide input counters and pointer samples until
the bounded duration expires. It performs no actions and records no key contents.
`/tmp/ad-headless-probe --self-test` verifies counter arithmetic including rollover.

Inspect its final JSON alongside action outputs. A target activation invalidates
the headless claim. Other app activations and input increments are environmental
activity with unknown attribution, not proof of either agent input or clean input
isolation. Pointer sampling can miss a move-and-return between samples. Unknown
foreground (`-1`), missing pointer samples or an exited target cannot pass a clean
monitoring gate. This observer improves evidence but is not an automatic score.

## Retained identity against the fixture

`retained-identity-probe.swift` is a read-only raw AX observer for the SwiftUI
fixture's ref-churn view (`tests/fixture-app/RefChurnView.swift`). Compile it
with `swiftc tests/real-apps/retained-identity-probe.swift -o /tmp/ad-retained-probe`
and run `/tmp/ad-retained-probe PID` against a running `AgentDeskFixture`. It
requires exactly one window with one `shared-title` field reading `Alpha` and
one `stable-editor`, retains the native `Alpha` element, prints `ready`, and
then reads stage labels from stdin. After each of `initial`, `filtered`,
`restored`, `edited`, and `cleared` it reports whether the retained element is
still a member of the live window tree and asserts that it is only in the tree
at `initial`; `quit` exits. Drive the fixture with raw Agent Desktop commands
between stages; the probe never mutates anything.

## Selection delivery fixture

`selection_delivery_fixture.swift` creates an owned background window named
`AD Reliability Selection Delivery`. Compile it with
`swiftc tests/real-apps/selection_delivery_fixture.swift -o /tmp/ad-selection-fixture`
and run it directly; it logs `READY pid=<PID>`. Its row accepts a direct
selected-state write but always reads back unselected, and its table container
independently accepts a selected-rows write. Each write is logged as
`MUTATION direct-selection <bool>` or `MUTATION container-selection <count>`,
so a trial can show which delivery path a `click` on the row took and whether
the fallback was attempted. Close only the printed PID with `kill -TERM PID`.
