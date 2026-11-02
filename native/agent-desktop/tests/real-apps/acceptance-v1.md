# Native reliability acceptance v1

Frozen task contract: 2026-09-20. Overall measured score: not established.
User scope update: stop Numbers testing. N1-N8 below remain historical evidence,
excluded from active qualification by explicit user instruction. Continue X1-X8,
S1-S5, D1 and the negative cases; do not silently drop any of those requirements.
The user-facing provisional baseline is 8/10. It is not a measured pass rate.
Previous 6, 7.5 and 8 ratings were provisional judgments, not acceptance results.
Do not promote historical probes into new-candidate acceptance passes.

## Candidate and execution rules

Starting candidate: `/tmp/ad-native-eval/window-context-candidate`, SHA-256
`2a4e3e248893e44432494c8b7d2a6d027ff8a76cc3058c52f029592eecaa6500`.
Branch: `codex/fix-chromium-ax-activation`. All work remains local.
Each changed candidate gets a new immutable binary/hash and separate results.

Use raw public CLI responses with model-selected qualified refs. Setup scripting
and raw AX diagnostics stay separate. Only owned disposable documents/windows
may be edited. The user-opened Xcode project is authorized for reversible
navigation, filtering, drilling and scrolling; do not edit its source or build/run
it. No focus stealing, physical input or clipboard-based insertion.
Observe target activation throughout each action/settling interval, inspect
same-window screenshots, and use independent document/file oracles.

For each attempted task record: candidate hash, seed hash, app/OS versions,
process/window/session identities, exact commands and raw responses, expected
and actual effect, screenshot paths, independent readback, elapsed time, and
headless evidence. Outcomes: pass, task_failed, unsupported, blocked_dependency,
contaminated, not_run. No inferred pass from native success or exit zero alone.
Failed mutations are never blindly retried. A rerun cannot erase an attempt.

## Required task outcomes

Numbers seed: Sheet 1 / Eval Grid, eight rows/five columns; B2=seed-target,
C2=neighbor-guard, B3=17, C3=25. Eval Other / Eval Grid has B2=other-sheet-guard.
Each text token includes the recorded batch/run number. Restore seed only between
independent trials and record setup separately.

| ID | Task | Required independent outcome |
|---|---|---|
| N1 | Cold-start list window, skeleton, drill to table/cell | Exact owned document, Sheet 1 and Eval Grid found; returned refs resolve |
| N2 | Select B2 using a snapshot ref | Raw selected-cell row/column and table identify B2; C2 unchanged |
| N3 | Enter edit mode, then reuse original cell ref | Same logical cell recovered; duplicate-table control is never chosen |
| N4 | Replace B2 with a unique token; replace B3 with 19; commit semantically | Document model reads exact token and 19; C2 and C3 unchanged |
| N5 | Set D3 to =B3+C3 and commit | Stored formula references B3/C3; calculated result is 44 after N4 |
| N6 | Switch Sheet 1 → Eval Other → Sheet 1 with saved refs | Active sheet agrees with get/is; both same-named table guards unchanged |
| N7 | Change row count 8 → 9 → 8 using original control ref | Document counts match each change; guard cells preserved |
| N8 | Save, close and reopen edited Numbers document | N4 token, numeric value and N5 formula/result persist; no unrelated document touched |
| X1 | Discover owned Xcode source editor | Correct file and editor ref; no other file selected |
| X2 | Replace owned source text and insert one comment using same ref | Exact requested file bytes and screenshot; comment appears once; guard retained |
| X3 | Save, close, reopen; query old editor ref | Edited bytes persist; old window ref cannot mutate reopened or unrelated windows |
| X4 | Open, inspect, select and dismiss owned editor-options menu | Intended menu/item effect, inventory/snapshot agreement and no target activation |
| X5 | Skeleton then drill navigator, editor, inspector and debug columns | Each returned root resolves to the expected region; sibling refs survive unrelated drills |
| X6 | Exact find within each column, including negative cross-column queries | Same identity/value as drill/get; no results leak from another region |
| X7 | Re-drill one column while retaining old child and sibling refs | Old child fails safely; new child resolves; untouched sibling still resolves |
| X8 | Expand/collapse navigator and inspector; filter/clear; editor scroll round trip | Same-ref state agreement, visible intended effects, restored UI and no headless-policy violations |
| S1 | SF Symbols skeleton → scope; first-match find → get/root | Same element identity and states across commands; honest partial-tree markers |
| S2 | Scroll down/up and reuse original scroll/control refs | Visible content/scroll value changes in intended direction; original refs resolve |
| S3 | Select Math → All using outline ref | Exact category selected and expected symbol collection visible |
| S4 | Scroll-to a discovered offscreen item | Intended item becomes visible; no substitute match or focus stealing |
| S5 | Open and close Weight menu semantically | Correct menu surface and dismissal, continuously monitored without activation |
| D1 | Drag between two owned native reorder/drop targets | Exact source/destination effect through supported headless semantics |

D1 has no proven headless-capable target/mechanism yet. It stays unsupported or
not_run until discovery supplies one; do not silently remove it or count refusal
as completion. Numbers cases are excluded from active qualification by the user update above.
Dependent failures stay visible instead of substituting pre-filled saved data.

## Mandatory negative cases

Retain saved refs while removing/replacing the target, introducing a lookalike,
closing/reopening its window and switching session namespaces. Verify no wrong
target or cross-session lookup. Exercise delayed readiness, failed native reads,
uncertain mutation returns and unchanged post-state with deterministic scripted
adapter tests. Assert dispatch count and delivery/retry classification.
CLI, batch and FFI must retain the same resolution and action contracts.

## Ordered trajectory and gates

1. Baseline: execute each task once on the frozen candidate; publish all outcomes.
   Existing probes are supporting evidence, not a completed frozen baseline.
2. Execute S1-S5 and X1-X8 on one frozen candidate, preserving every failure.
   Investigate only blockers demonstrated by these tasks or mandatory negatives.
3. Establish a supported semantic mechanism for D1 without physical input or
   activation. If none is demonstrated, retain the unmet requirement explicitly.
4. Complete the cross-app tasks. Resolve supported-action and
   state inconsistencies at their existing shared boundary. Keep native limits
   visible and investigate them separately from core/adapter defects.
5. Repeatability: thirty consecutive valid runs per supported task across three
   independent reset batches of ten. Preserve all failed/contaminated attempts.
   A new build starts a new series; do not pool revisions into a passing series.
6. Final qualification: all required outcomes and negative cases pass, full
   workspace/format/lint/native gates pass, performance is reviewed on the exact
   candidate, and another review checks the evidence and blast radius. No push
   or release without the applicable user authorization.

Report per-task successes/attempts and unmet coverage separately. Unsupported,
blocked and unrun tasks cannot earn completion credit. No aggregate score is
computed until every task's denominator and observations exist. Any wrong-target
write, duplicate effect, false verification or prohibited input/focus effect
fails qualification regardless of the aggregate. No 9/10 or 10/10 from code
volume, fixture counts, a few successful probes, or an incomplete denominator.

Historical Numbers trials are retained in their evidence documents. Do not resume
them or introduce another backend under the active scope without user direction.
