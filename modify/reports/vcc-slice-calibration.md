# VCC partial-compaction: what a compiled slice summary covers

A reading of how much of a session slice survives `runVccSliceCompaction`, and
which parts of the loss are worth fixing. Every number here is deterministic —
derived from the transcripts and the compiled summary text, with no model call —
so a re-run reproduces it exactly. The raw machine dump this reading is based on
is written to `vcc-slice-calibration.generated.md`, which is **not committed**:
it lists per-scenario paths and would otherwise publish transcripts.

```bash
cd <repo>
bun run scripts/vcc-slice-calibration.ts --max 20
```

## 1. What is measured

- **Corpus**: real session JSONL under `~/.claude/projects`, 20 largest sessions.
- **Slices**: taken outward from a pivot at 0.25 / 0.5 / 0.75 of each session,
  both directions (`up_to` summarizes before the pivot, `from` after it), to a
  budget of **750,000 characters of message text**. Two variants are compared:
  `default` (the shipped section policy) and `none` (no sections suppressed).
- **File recall**: the share of paths named anywhere in the slice that the
  summary names. A path counts as "touched" if *any* tool call names it, so the
  denominator includes files that were only read.
- Also counted: invented paths, `#N` refs that do not resolve, refs pointing
  outside the summarized span, compression ratio, and bash-entry noise.

Slice size is stated in **characters, not messages**. A message count is not a
size: one tool result can outweigh a hundred short turns, and a 600-message cap
produced spans from 327k to 5,179k characters — a range of 16×, none of which
resembled the window a real compaction runs over.

## 2. Measured

| variant | mean recall | median | inventions | unresolvable refs | refs outside span | compression | bash entries |
|---|---|---|---|---|---|---|---|
| `default` | 87.1% | 88.9% | 0 | 1 | 0 | 0.8% | 1762 |
| `none` | 87.1% | 88.9% | 0 | 1 | 4 | 0.9% | 1785 |

Split by what the tool did to the file:

| category | recall | of the misses |
|---|---|---|
| modified (`Edit` / `MultiEdit` / `Write`) | **425/438 = 97.0%** | 8.6% |
| read (`Read`) | 714/787 = 90.7% | 48.3% |
| other (path-bearing tools, e.g. `Grep`) | 185/250 = 74.0% | 43.0% |
| **all** | **1324/1475 = 89.8%** | |

## 3. What the numbers mean

**File recall is dominated by files that were only read.** Half the misses are
`Read` entries. Raising the headline number therefore mostly means listing more
files that were opened and not changed — which tells a reader nothing and
crowds out the list that matters. Read those columns, not the mean.

**The reader-relevant gap was changed-but-unnamed files, and it is now closed.**
A slice edits up to 28 files; the section capped each category at 10, so beyond
the tenth file the name was dropped and replaced with `(+N more)`. Raising the
`Modified`/`Created` cap to 36 (measured max 28, so it leaves headroom) moved:

| | changed files named | all files |
|---|---|---|
| cap 10 | 416/438 = 95.0% | 1310/1475 = 88.8% |
| **cap 36** | **425/438 = 97.0%** | **1324/1475 = 89.8%** |

`Read` keeps its cap of 10: those entries cost the same width and carry less.

**The brief-transcript ceiling is inert at this size.** The budget is
`clamp(15 tok/block × blockCount, 1100, ceiling)`; on these slices the slope term
stays under the floor, so the budget *is* the floor and every ceiling from 1600
to 3600 produces byte-identical output. The ceiling was still raised to 2500, as
a bound on the very large slices where it does bind.

**Compression is ~1%.** The summary is roughly a hundredth of the text it
replaces. It is a brief, not an abstract: structure (goal, files, blockers,
commits) plus a ranked tool log.

## 4. Metric caveats

- **`refs outside span` is not a quality score.** It counts `#N` refs that
  resolve but point outside the summarized slice. Suppressing the section that
  emits them *lowers* this number, so reading it as "lower is better" rewards
  dropping content — it is why `default` scores better than `none` here while
  being the more aggressive policy.
- `lines > 300 chars` is structurally always 0: the compiler wraps at 120.
- Paths are compared by suffix, because the extractor strips the longest common
  directory prefix. Recall is lenient about *which spelling* appears, never
  about whether the file appears.
- Slices are drawn outward from a pivot of a **capped** session (1200 messages),
  so absolute recall for a particular real pivot may differ.

## 5. History: defects found and their state

### 5.1 Suppressing a section used to take its neighbours — fixed

`SLICE_OMITTED_SECTIONS` names two sections, but everything above the `---` was
one block whose *first* header was `Session Goal`, and the suppressor matched on
the first header of each `---`-delimited block. Dropping `Session Goal`
therefore also dropped `Files And Changes`, `Commits` and `Outstanding Context`.
When `Session Goal` happened to be empty the block survived — which is why the
failure was intermittent. Measured at the time: `default` recall 59.6% against
`none` at 83.7% on identical slices, with `Files And Changes` kept in 6 of 113
scenarios. Now the split is on the known header lines, so a section is removed on
its own account: `Files And Changes` is kept in 113/113.

### 5.2 `Commits` is dead in this adapter path — open, deliberately

`extractCommits` only inspects blocks with `kind === "tool_call"` and
lowercase `name === "bash"`. This adapter emits Bash tool calls under their
original name `"Bash"`, and Bash results as separate `kind: "bash"` blocks, so
neither matches and the section is empty in all 240 scenarios. Reshaping the
blocks does make the extractor fire, but it then captures the heredoc opener
(`$(cat <<'EOF'`) as the commit message — garbled text presented as authoritative
commit data is worse than the omission, so it is left alone.

### 5.3 Refs could point outside the span — fixed

A slice that contains an earlier compact summary merges that summary, inheriting
`#N` refs for messages the previous compaction covered — which on a partial
compaction sit on the side being kept. They resolve (the index is session-wide),
so nothing errored; the reader was simply sent outside what the summary claims
to describe. Refs that land inside the span are kept. Measured: refs outside span
4 → 0, grouped refs (`(#13, #14)`) included.

### 5.4 Tool-arg noise is bounded but real

Bash entries carry up to 243 characters of command text per line, and long
heredocs are the bulk of it. Bounded by `compressBash`, not eliminated.

## 6. Why the slice size matters more than it looks

The same code scored 90.4% (median 100%) on 60k-character slices, 87.1% (88.9%)
on 750k, and 81.7% (83.5%) on 1.6M. Nothing changed but the size of the span
being summarized. A summary has a fixed budget; a longer span must drop more of
it, and the loss lands on the long tail. **Absolute recall is only meaningful
with the slice size stated**, and the size must resemble what production
actually compacts: the auto-compact threshold here is 418,200 tokens
(~1.7M characters), of which the kept tail is 5–25k tokens, so a real
compaction summarizes on the order of 1.6M characters. 750k is used as the
default because a full-size run is slow and both sizes rank the variants the
same way.

This is also the trap the numbers invite: measuring at a small slice flatters
every metric, and comparing runs taken at different sizes measures the sizes,
not the change. Two rounds of comparison in this work were thrown away for
exactly that reason.
