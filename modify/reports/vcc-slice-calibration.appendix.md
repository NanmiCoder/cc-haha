## 5. Analyst reading (hand-written)

This section is a reading of sections 1-4, not a measurement. It is kept in
`vcc-slice-calibration.appendix.md` so a re-run of the script regenerates the
measured sections without dropping it.

### 5.1 The headline defect: `default` drops four sections, not two

`SLICE_OMITTED_SECTIONS` names two sections, but `default` removes a whole
header block whenever `Session Goal` is present. The mechanism, from the code
under test:

- `formatSummary` (vendor) builds the header region by joining every header
  section with a plain blank line, then joins that region to the brief with
  `\n\n---\n\n`.
- `omitSections` (vccCompact) splits the summary on `\n\n---\n\n` and inspects
  only `/^\[([^\]]+)\]/` — the FIRST header of each block.

So the entire header region is one block whose first header is `Session Goal`,
and matching it discards `Files And Changes`, `Commits` and `Outstanding
Context` along with the two intended sections. When `Session Goal` happens to
be empty the block starts with `[Files And Changes]` and survives — which is
why the failure is intermittent and easy to miss in a spot check.

The pairing counts in section 4 make it unambiguous: in all 114 scenarios where
`none` emits `Session Goal`, `default` also loses `Files And Changes`; of the
113 scenarios where `none` emits `Files And Changes`, `default` keeps it in 6
and drops it in 107. Recall falls from 83.7% (`none`) to 59.6% (`default`) on
the same slices, with identical inventions and ref health — the policy is
costing ~24 points of file recall to suppress two sections.

Concrete output (`60aa321f` up_to @ pivot 900, `default`): the summary opens
directly with

```
[assistant]
* Write "/home/zeaxion/.claude/projects/.../memory/project_cc_haha_upstream_v06
  6_crosscheck.md"
```

There is no `[Files And Changes]` block at all, and 27 of the 47 files the slice
touched are named nowhere — including `src/server/services/conversationService.ts`
and `desktop/src/pages/settings/H5AccessSettings.tsx`, both edited inside the
slice. The corresponding `none` summary for the same slice emits
`[Session Goal]` and `[Files And Changes]` and recovers 31/47, versus 20/47 for
`default`, whose brief transcript alone carries all of its file evidence.

**First change to try** (in `omitSections`, one of the few lines that is
allowed to move if the freeze is ever lifted): operate per header line, not per
`---` block. Walk the first `---`-delimited block, split it into runs that each
begin at `^\[Header\]`, and drop only the runs whose header is in `omitted`,
keeping the rest. That removes exactly the two session-claiming sections and
leaves the span facts intact. Until that lands, `omitSections: []` is strictly
better for recall — it over-claims `Session Goal`/`User Preferences` (see the
`none` policy violations) but does not destroy `Files And Changes`.

### 5.2 `Commits` is dead code in the cc-haha adapter path

`Commits` was emitted 0 times in 240 scenarios, under both variants. The cause
is a shape mismatch: `extractCommits` (vendor) only inspects blocks with
`kind === "tool_call"` and `name === "bash"` (lowercase). The adapter emits
Bash *tool calls* as `tool_call` with the original name `"Bash"`, and Bash
*tool results* as `kind: "bash"` (a `bashExecution` block) — neither matches.
So no commit is ever extracted, even in sessions full of `git commit`. Worth
fixing at the adapter boundary (emit `name: "bash"` for the Bash tool call) or
by widening the vendor match; not fixable inside the frozen interface.

### 5.3 Refs can point outside the summarized span

Four scenarios (both variants) render `(#8)`/`(#52)` while summarizing only the
tail of the session. Cause: the slice contains an `isCompactSummary` user
message, `extractPreviousSummary` merges that earlier summary, and its literal
`(#N)` refs — which belong to the pre-pivot, kept side — survive verbatim into
the new brief:

```
This session is being continued from a previous conversation that ran out of context ...
2+2 等于 4 ... 。 (#8)
```

Those refs resolve (`vcc_recall` will find them) but they point at the kept
side, so a reader is sent to messages the slice explicitly does not cover. The
section policy anticipates exactly this class of error for headers and has no
equivalent guard for refs; a partial compaction should drop or rewrite refs
inherited from a prior summary.

### 5.4 Tool-arg noise is bounded but real

`compressBash` caps a rendered command at 240 chars, so the worst observed
entry is 243 chars, not the unbounded shell dump the whole-window compactor has
been seen to emit. Still, a ~240-char Python/`find` one-liner is the single
largest thing in an otherwise ~6 KB brief. Example (`11faeccb` up_to @ 600):

```
F=/mnt/data1/modelfiles/nerkyor-Qwen3.8-27B-EfficientThink-DFlash2-NVFP4-W4A4/.snap/.cache/huggingface/download/
NVFP4/W4A4/hVn7b6M65rKYsPHzUeyl3nDwoMY=.9b7e1c4d839995ee9ed35ac682ecf31e81ae4bc6ddb4e3aaa7f585b786bb83a0.6c9ec67b.inco
mplete;...
```

A lower `BASH_CAP` or a "keep only the leading command verb + first path" rule
would pay for itself; the argument is unreconstructable context by the time it
is read.

### 5.5 Metric caveats and what could not be measured as specified

- `lines > 300 chars` / `longest line`: structurally always 0 / <=120 because
  `compileRanked` runs `wrapLongLines` at 120. Reported as specified but
  meaningless; the bash unwrap columns are the usable proxy.
- **The ref columns can be polluted by the assistant's own prose** (found
  2026-09-27). The extractor matches `\((#\d+...)\)` anywhere, but a `#N` in the
  brief may be the assistant numbering its own work, not a recall ref — e.g. a
  summary quoting "move to the remaining piece (#9): ..." was counted as one
  unresolvable ref. Recorded outcomes only: the count is an upper bound on ref
  defects, and a single flagged ref is not by itself evidence of a regression.
  The reverse hazard is real for a reader too — vcc renders refs as `(#N)`, and
  the assistant's task numbering looks identical, so a summary can carry a `#N`
  that resolves to nothing (or to the wrong message).
- The bash unwrap is approximate: it reconstructs a wrapped entry only when the
  entry ends in a `(#N)` ref, and measures only the first line otherwise (a
  ref-less entry, i.e. an unresolved index, cannot be told from the following
  assistant paragraph). Recovered lengths are therefore a slight undercount.
- Slices are drawn from a per-session cap (1200 messages / 6 MB); 16 of the 20
  sessions were capped. Real partial compactions run over much smaller windows,
  so absolute recall for a production pivot may differ; the `default` vs `none`
  delta does not, because both variants see the identical slice.
- File paths are matched by suffix/trim rules because `extractFiles` strips the
  longest common directory prefix. Recall is therefore lenient about *which*
  spelling appears, not about whether the file appears at all. Invented-path
  detection is deliberately suffix-tolerant to survive the 120-char wrapper
  cutting a path mid-token; it reports 0 across all 240 scenarios, which given
  every path in a slice summary is derived from the slice is the expected
  result — the metric's real job is to catch paths leaking in from a merged
  prior summary, and it found none.

### 5.6 Worst five, and what is wrong with each

1. `353a69e2` up_to @ 900 (`none`): 17/47 files missed, `Session Goal`
   over-claim. The slice is huge (900 messages); `Files And Changes` caps at 10
   per category, so the long tail is structurally unrecoverable. This is a
   budget problem, not a policy one.
2. `4e1f6c0c` up_to @ 900 (`none`): same shape, 17 missed.
3. `60aa321f` up_to @ 900 (`none`): 16 missed, same cap effect.
4. `353a69e2` up_to @ 600 (`none`): 15 missed.
5. `60aa321f` up_to @ 600 (`none`): 12 missed.

Under `default` the same scenarios are *worse* in a way the defect score
understates: they additionally lose the whole header block, so their only file
evidence is the ranked brief. The score ranks `none` highest because it adds a
`Session Goal` policy hit that `default` avoids by dropping the section; read
the recall column, not the score, when comparing variants.

---

### Correction (2026-09-27, after the reading above)

The two defects this reading identified in §5.1 and §5.3 have been **fixed**, so
the numbers quoted above describe the state *before* the fix. Corrections, so a
reader does not take the superseded figures as current:

- §5.1 — `omitSections` now splits on the **known header lines** rather than on
  `---`, so a suppressed section no longer takes its neighbours with it.
  Measured after the fix: `default` file-recall **59.6% → 83.7%** (mean),
  `Files And Changes` kept in **113/113** and dropped in **0**.
- §5.3 — a slice now strips inherited refs that fall outside the span
  (`stripRefsOutside`). Measured after the fix: refs outside slice
  **4 → 0** (and grouping like `(#13, #14)` is handled, which the first attempt
  missed).
- §5.2 (`Commits`) is **still open and deliberately not fixed**: reshaping the
  bash blocks does make the vendor extractor succeed, but it captures the
  heredoc form as the message (`$(cat <<'EOF'`), so emitting the section would
  put garbled text where authoritative commit info is expected.
- §5.4 (bash noise, 243 chars) and the per-category file cap in §5.6 are
  unchanged.

The measured tables in `vcc-slice-calibration.md` are regenerated on every run
and are authoritative; this appendix is a reading, not a measurement.
