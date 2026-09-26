// Deterministic calibration harness for `runVccSliceCompaction` (partial
// compaction). Measurement only: it never calls a model and never touches the
// code under test. Every metric is derived from the session JSONL and the
// compiled summary text, so a run is reproducible byte-for-byte.
//
// Why a harness rather than a unit test: the interesting failures (refs that
// point outside the summarized span, files the brief silently dropped, whole
// Bash one-liners pasted into the brief) only appear against real transcripts.
//
// Run: bun run scripts/vcc-slice-calibration.ts [--variant both] [--max 20]
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { basename, dirname, isAbsolute, join, resolve } from "node:path"
import type { CcMessage } from "../src/services/compact/vcc/adapter"
import {
  runVccSliceCompaction,
  SLICE_OMITTED_SECTIONS,
  sectionsOf,
} from "../src/services/compact/vcc/vccCompact"
import { loadCcGlobalIndexByUuid } from "../src/services/compact/vcc/ccGlobalIndex"
import { forEachJsonlLine } from "../src/services/compact/vcc/vendor/core/jsonl"

// ── CLI ────────────────────────────────────────────────────────────────────

interface Options {
  corpus: string
  out: string
  variants: Array<"default" | "none">
  only: string | null
  maxSessions: number
  maxMessages: number
  maxBytes: number
  minMessages: number
  pivots: number[]
  fullSummaries: boolean
}

// The repo's preload.ts chdirs to $CALLER_DIR (the caller's workspace), so a
// relative --out written from process.cwd() lands outside the repo. Anchor
// relative paths to the script's own tree instead.
const REPO_ROOT = resolve(import.meta.dir, "..")

const parseArgs = (argv: string[]): Options => {
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(name)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const variant = get("--variant") ?? "both"
  const variants =
    variant === "both" ? (["default", "none"] as const) : ([variant] as const)
  for (const v of variants)
    if (v !== "default" && v !== "none") throw new Error(`unknown variant: ${v}`)
  const num = (name: string, dflt: number): number => {
    const v = get(name)
    return v === undefined ? dflt : Number(v)
  }
  const outArg = get("--out") ?? "modify/reports/vcc-slice-calibration.md"
  return {
    corpus: get("--corpus") ?? "/home/zeaxion/.claude/projects",
    out: isAbsolute(outArg) ? outArg : resolve(REPO_ROOT, outArg),
    variants: [...variants],
    only: get("--only") ?? null,
    maxSessions: num("--max", 20),
    // Per-session caps. The corpus tops out at 146 MB; parsing every line of
    // every large session would make a 20-session run take tens of minutes, so
    // each session contributes at most this many message lines / raw bytes and
    // the report records the cap. Caps are per session, not global.
    maxMessages: num("--max-messages", 1200),
    maxBytes: num("--max-bytes", 6_000_000),
    minMessages: num("--min-messages", 8),
    pivots: (get("--pivots") ?? "0.25,0.5,0.75")
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 0 && n < 1),
    fullSummaries: !argv.includes("--no-full-summaries"),
    // Slice size, in the characters the compactor actually sees. Sized in text
    // rather than message count: one tool result can outweigh a hundred short
    // turns, so a message cap gave spans of wildly different sizes -- measured
    // 75k to 12M chars -- none of which resemble a production window.
    //
    // 750k is the production figure for this deployment, not a round number:
    // auto-compact fires at ~82% of the declared window
    // (`getAutoCompactThreshold`), and the local engine's window is 204,800
    // tokens, so the summarized side is ~170k tokens ~= 750k characters at the
    // calibrated 4 chars/token. A smaller testing budget is much easier to
    // satisfy and flatters recall, so it must be chosen on purpose.
    sliceChars: num("--slice-chars", 750_000),
  }
}

// ── slice sizing ───────────────────────────────────────────────────────────

/** Roughly the text of one message, for size accounting only. */
const messageChars = (m: CcMessage): number => {
  const c = (m as any).message?.content
  if (typeof c === "string") return c.length
  if (!Array.isArray(c)) return 0
  let n = 0
  for (const b of c) {
    if (typeof b?.text === "string") n += b.text.length
    else if (typeof b?.thinking === "string") n += b.thinking.length
    else if (b?.type === "tool_use") n += JSON.stringify(b.input ?? {}).length
    else if (b?.type === "tool_result") {
      n += typeof b.content === "string" ? b.content.length : JSON.stringify(b.content ?? "").length
    }
  }
  return n
}

/**
 * Take the messages adjacent to the pivot, up to a character budget.
 *
 * Adjacent rather than from the edge: the pivot is where a reader chose to
 * split, so the messages nearest it are the ones the summary is most about.
 * At least one message is always taken, so a single oversized message yields a
 * one-message slice instead of an empty one.
 */
const takeAroundPivot = (
  messages: CcMessage[],
  pivot: number,
  direction: "up_to" | "from",
  budget: number,
): CcMessage[] => {
  if (budget <= 0) {
    return direction === "up_to" ? messages.slice(0, pivot) : messages.slice(pivot)
  }
  const out: CcMessage[] = []
  let used = 0
  if (direction === "up_to") {
    for (let i = pivot - 1; i >= 0; i--) {
      const size = messageChars(messages[i])
      if (out.length > 0 && used + size > budget) break
      out.unshift(messages[i]); used += size
    }
  } else {
    for (let i = pivot; i < messages.length; i++) {
      const size = messageChars(messages[i])
      if (out.length > 0 && used + size > budget) break
      out.push(messages[i]); used += size
    }
  }
  return out
}

// ── corpus ─────────────────────────────────────────────────────────────────

interface Session {
  file: string
  bytes: number
}

/** Top-level session files only; `<project>/<uuid>/` dirs hold subagents. */
const discoverSessions = (corpus: string, only: string | null): Session[] => {
  const out: Session[] = []
  let projects: string[]
  try {
    projects = readdirSync(corpus)
  } catch {
    return out
  }
  for (const project of projects) {
    const dir = join(corpus, project)
    let entries: ReturnType<typeof readdirSync>
    try {
      if (!statSync(dir).isDirectory()) continue
      entries = readdirSync(dir)
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.endsWith(".jsonl")) continue
      const file = join(dir, entry)
      try {
        if (!statSync(file).isFile()) continue
      } catch {
        continue
      }
      if (only && !matchesOnly(file, only)) continue
      out.push({ file, bytes: statSync(file).size })
    }
  }
  // Largest first: that is where compaction actually has to work, and the cap
  // then hits the sessions whose slices are most expensive to measure.
  return out.sort((a, b) => b.bytes - a.bytes)
}

const matchesOnly = (file: string, only: string): boolean => {
  if (only.includes("*"))
    return new RegExp("^" + only.split("*").map(escapeRe).join(".*") + "$").test(
      file,
    )
  return file.includes(only)
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

interface Loaded {
  messages: CcMessage[]
  /** True when the per-session cap stopped the load early. */
  capped: boolean
  bytesSeen: number
}

const isCountedLine = (line: any): boolean =>
  (line?.type === "user" || line?.type === "assistant") && line?.message != null

/**
 * Stream one session into at most `opts.maxMessages` message lines / `maxBytes`
 * raw bytes. The predicate mirrors ccGlobalIndex's `isCountedCcLine` exactly,
 * so a line the global index counts is a line we keep — the two must agree or
 * every ref check is measured against a different rule than the one that
 * renders it.
 */
const loadSession = (file: string, opts: Options): Loaded => {
  const messages: CcMessage[] = []
  let bytesSeen = 0
  let capped = false
  forEachJsonlLine(file, (line) => {
    if (capped) return
    bytesSeen += line.length + 1
    if (
      messages.length >= opts.maxMessages ||
      bytesSeen >= opts.maxBytes
    ) {
      capped = true
      return
    }
    try {
      const parsed = JSON.parse(line.toString("utf8"))
      if (isCountedLine(parsed)) messages.push(parsed as CcMessage)
    } catch {
      // Corrupt lines are dropped, matching the global index.
    }
  })
  return { messages, capped, bytesSeen }
}

// ── slice path extraction ──────────────────────────────────────────────────

const PATH_KEYS = ["file_path", "filePath", "path", "notebook_path"] as const

const pathOfInput = (input: any): string | undefined => {
  if (!input || typeof input !== "object") return undefined
  for (const k of PATH_KEYS)
    if (typeof input[k] === "string" && input[k]) return input[k]
  return undefined
}

// Bash file arguments, "if cheap": tokenize on shell metacharacters and keep
// only tokens that look like a path (absolute/relative prefix or a file
// extension). Options (`-x`) and bare words are dropped; this is a heuristic
// and undercounts deliberately rather than guessing at prose.
const BASH_PATH_TOKEN_RE = /^(?:[~.]?\/|\.\.\/|[A-Za-z0-9_@$-]+\/).+/
const FILE_EXT_RE = /\.(?:[A-Za-z0-9]{1,8})$/

const bashPaths = (command: string): string[] => {
  const out: string[] = []
  for (const raw of command.split(/[\s|;&<>()='"`]+/)) {
    const tok = raw.trim()
    if (!tok || tok.startsWith("-")) continue
    if (/^https?:\/\//.test(tok)) continue
    if (!BASH_PATH_TOKEN_RE.test(tok) && !FILE_EXT_RE.test(tok)) continue
    if (!tok.includes("/") && !FILE_EXT_RE.test(tok)) continue
    out.push(tok)
  }
  return out
}

interface SlicePaths {
  /** Paths named by Read/Edit/Write-style tool_use inputs (authoritative). */
  tool: Set<string>
  /** Paths recovered from Bash commands (heuristic, reported separately). */
  bash: Set<string>
}

const collectSlicePaths = (messages: CcMessage[]): SlicePaths => {
  const tool = new Set<string>()
  const bash = new Set<string>()
  for (const m of messages) {
    const c = m.message?.content
    if (!Array.isArray(c)) continue
    for (const b of c) {
      if (b?.type !== "tool_use") continue
      const name = String(b.name ?? "")
      const p = pathOfInput(b.input)
      // Any tool_use naming a path counts as "touched": the recall denominator
      // is "files the slice actually referenced", not just edit/read tools.
      if (p) tool.add(p)
      if (/^(?:bash|Bash|PowerShell)$/.test(name)) {
        const cmd = b.input?.command
        if (typeof cmd === "string") for (const q of bashPaths(cmd)) bash.add(q)
      }
    }
  }
  return { tool, bash }
}

// ── summary path extraction ────────────────────────────────────────────────

// Absolute paths anywhere in the summary, used for invention grounding and as
// a recall fallback when the Files And Changes section was dropped.
const ABS_PATH_RE = /(?:\/[\w.@%+~=-]+){2,}\/?(?:[\w.@%+~=-]+)*/g

const CATEGORY_RE = /^- (Modified|Created|Read): (.*)$/
const BRIEF_PATH_RE = /^\* (Read|Edit|Write|MultiEdit|NotebookEdit) "([^"]*)"/

/**
 * Split one comma-list fragment into path tokens. `(+N more)` is stripped here
 * because the cap suffix lands on the last path of a category and therefore
 * also on wrapped continuation lines, where a naive suffix strip misses it and
 * the whole "path (+13 more)" is then scored as an invented path. A token that
 * still contains whitespace is a path split by the 120-char wrapper, so its
 * fragments are kept individually — they are grounded as substrings later.
 */
// Junk left behind when the wrapper splits `(+N more)` across a line break.
const isMoreJunk = (t: string): boolean =>
  /^\(\+\d*$/.test(t) || /^more\)?$/.test(t) || /^\(\+\d+\s*$/.test(t)

const pushDeclared = (out: string[], fragment: string): void => {
  for (const raw of fragment.split(",")) {
    const t = raw.trim().replace(/\s*\(\+\d+ more\)\s*$/, "")
    if (!t || isMoreJunk(t)) continue
    if (/\s/.test(t)) {
      for (const f of t.split(/\s+/)) if (f && !isMoreJunk(f)) out.push(f)
    } else {
      out.push(t)
    }
  }
}

/**
 * Declared paths in the Files And Changes section. Reconstructed line-by-line
 * because compileRanked wraps output at 120 chars, so a category's comma list
 * can spill onto continuation lines that no longer start with `- `.
 */
const sectionPaths = (summary: string): string[] => {
  const declared: string[] = []
  let inSection = false
  let current: string[] | null = null
  for (const line of summary.split("\n")) {
    if (/^\[Files And Changes\]/.test(line)) {
      inSection = true
      continue
    }
    if (!inSection) continue
    if (/^\[/.test(line) || line === "---") {
      current = null
      inSection = false
      continue
    }
    const m = CATEGORY_RE.exec(line)
    if (m) {
      current = []
      pushDeclared(declared, m[2])
      continue
    }
    if (current !== null && line.trim()) {
      pushDeclared(declared, line.trim())
      continue
    }
    if (!line.trim()) current = null
  }
  return declared
}

const briefPaths = (summary: string): string[] => {
  const out: string[] = []
  for (const line of summary.split("\n")) {
    const m = BRIEF_PATH_RE.exec(line)
    if (m?.[2]) out.push(m[2])
  }
  return out
}

const absPaths = (text: string): string[] =>
  (text.match(ABS_PATH_RE) ?? []).filter(
    (p) => p.length > 3 && (p.startsWith("/") || p.includes(".")),
  )

// ── refs, commits, noise ───────────────────────────────────────────────────

// Matches both a lone `(#12)` and the collapsed `(#12, #13) x2` form.
const REF_RE = /\(#(\d+)((?:\s*,\s*#\d+)*)\)/g

const refsIn = (summary: string): number[] => {
  const out: number[] = []
  for (const m of summary.matchAll(REF_RE)) {
    out.push(Number(m[1]))
    for (const extra of m[2].matchAll(/#(\d+)/g)) out.push(Number(extra[1]))
  }
  return out
}

const HASH_RE = /\b[0-9a-f]{7,40}\b/g

/**
 * Bash noise. `wrapLongLines` caps every physical line at 120 chars, so the
 * literal "longest line / lines > 300" reading of the brief can never fire; we
 * report those raw (degenerate) values and additionally unwrap each rendered
 * Bash entry to recover the length of the command actually pasted in. The
 * reconstruction joins the continuation lines that follow a `$ ...` / `* Bash
 * "..."` line until a blank line, a section header, or a new tool line.
 */
interface BashNoise {
  count: number
  maxChars: number
  totalChars: number
  worst: string | null
}

const bashNoise = (summary: string): BashNoise => {
  const lines = summary.split("\n")
  let head: string | null = null
  let tail = ""
  let endedByRef = false
  let cont = 0
  let count = 0
  let maxChars = 0
  let totalChars = 0
  let worst: string | null = null
  const finish = () => {
    if (head === null) return
    // Only unwrap when the entry terminated in a `(#N)` ref, which every brief
    // entry carries — and which is the only reliable end marker. A ref-less
    // entry (unresolved index) has no such marker, so its continuation lines
    // cannot be told from the assistant paragraph that follows it; measure only
    // its first line rather than report swallowed prose as a long Bash command.
    const joined = endedByRef ? head + tail : head
    const text = joined.replace(/\s*\(#[^)]*\)\s*$/, "")
    const len = text.length
    totalChars += len
    if (len > maxChars) {
      maxChars = len
      worst = text
    }
    head = null
    tail = ""
    endedByRef = false
    cont = 0
  }
  const isEntryEnd = (line: string): boolean => /\(#\d+\)$/.test(line)
  for (const line of lines) {
    const m = /^(?:\$ |\* (?:Bash|bash) ")(.*)$/.exec(line)
    if (m) {
      finish()
      count++
      head = m[1]
      if (isEntryEnd(m[1])) {
        endedByRef = true
        finish()
      }
      continue
    }
    if (head === null) continue
    if (
      line === "" ||
      /^\[/.test(line) ||
      /^\* /.test(line) ||
      /^\$ /.test(line) ||
      line.startsWith("Use `vcc_recall`")
    ) {
      finish()
      continue
    }
    // `compressBash` caps a command at 240 chars, so a rendered entry spans at
    // most a few 120-char lines; the cap stops a ref-less entry from unbounded
    // accumulation even before `finish` discards it.
    tail += " " + line.trim()
    if (isEntryEnd(line)) {
      endedByRef = true
      finish()
    } else if (++cont >= 4) finish()
  }
  finish()
  return { count, maxChars, totalChars, worst }
}

// ── scoring ────────────────────────────────────────────────────────────────

const basenameOf = (p: string): string => p.replace(/\/+$/, "").split("/").pop() ?? p

interface ScenarioMetrics {
  slicePathCount: number
  foundPathCount: number
  missedPaths: string[]
  inventedPaths: string[]
  inventedHashes: string[]
  refTotal: number
  refUnresolvable: number[]
  refOutsideSlice: number[]
  sliceChars: number
  summaryChars: number
  compressionPct: number
  sections: string[]
  policyViolations: string[]
  longestLine: number
  linesOver300: number
  bash: BashNoise
  sourceMessageCount: number
}

interface ScenarioResult extends ScenarioMetrics {
  variant: "default" | "none"
  direction: "up_to" | "from"
  pivot: number
  pivotUuid: string | null
  summary: string
}

const scoreScenario = (input: {
  summary: string
  slice: CcMessage[]
  sliceRawText: string
  sliceIndexSet: Set<number>
  globalValues: Set<number>
}): ScenarioMetrics => {
  const { summary, slice, sliceRawText, sliceIndexSet, globalValues } = input
  const paths = collectSlicePaths(slice)

  // Recall treats a trimmed (relative) summary path as covering its absolute
  // original: the compiler strips the longest common directory prefix, so
  // `b.ts` legitimately stands in for `/a/b.ts`.
  const summaryText = summary
  const declared = sectionPaths(summary)
  const brief = briefPaths(summary)
  // Tokens that survive only as a mid-path fragment (assistant prose or the
  // 120-char wrapper cutting a path) arrive with a trailing ellipsis; strip it
  // so the fragment is grounded against the real path instead of scoring as an
  // invented name.
  const trimEllipsis = (s: string): string =>
    s.replace(/\.{3,}.*$/, "").replace(/….*$/, "").replace(/\.+$/, "").trim()
  // Source-tagged so an "invention" can be traced to the extractor that
  // produced it (section list, quoted brief arg, or bare absolute path).
  const allSummary = (
    [
      ...declared.map((v) => [v, "section"] as const),
      ...brief.map((v) => [v, "brief"] as const),
      ...absPaths(summary).map((v) => [v, "abs"] as const),
    ] satisfies Array<readonly [string, string]>
  )
    .map(([v, src]) => [trimEllipsis(v), src] as const)
    .filter(([v]) => Boolean(v) && !isMoreJunk(v))
  const summaryNorm = new Set(allSummary.map(([p]) => p.replace(/^\.\//, "")))
  const covers = (p: string): boolean => {
    if (summaryText.includes(p)) return true
    const b = basenameOf(p)
    for (const s of summaryNorm) {
      if (s === p || s === b) return true
      if (p.endsWith("/" + s) || s.endsWith("/" + p)) return true
    }
    return false
  }

  const missed: string[] = []
  let found = 0
  const toolPaths = [...paths.tool]
  for (const p of toolPaths) {
    if (covers(p)) found++
    else missed.push(p)
  }

  // No-invention: every path in the summary must be grounded in the slice,
  // either literally or as a suffix of a slice-authored path (trim) / by
  // appearing anywhere in the slice text.
  const inventedTagged = allSummary.filter(([s]) => {
    if (!s || s.length < 3) return false
    if (sliceRawText.includes(s)) return false
    for (const p of toolPaths) {
      if (p === s || p.endsWith("/" + s) || s.endsWith("/" + p)) return false
      // A wrapper-truncated or trim-truncated fragment of a real path is not an
      // invention. Only long-enough tokens qualify, so a short hallucinated name
      // cannot hide inside an unrelated path by coincidence.
      if (s.length >= 5 && (p.includes(s) || s.includes(p))) return false
    }
    return true
  })
  const inventedPaths = inventedTagged.map(([s, src]) => `${s} [${src}]`)

  const inventedHashes = (summary.match(HASH_RE) ?? []).filter(
    (h) => !sliceRawText.includes(h),
  )

  const refs = refsIn(summary)
  const refUnresolvable: number[] = []
  const refOutsideSlice: number[] = []
  for (const r of refs) {
    if (!globalValues.has(r)) refUnresolvable.push(r)
    else if (!sliceIndexSet.has(r)) refOutsideSlice.push(r)
  }

  const sliceChars = sliceRawText.length
  const summaryChars = summary.length
  const lines = summary.split("\n")
  const longestLine = lines.reduce((a, l) => Math.max(a, l.length), 0)
  const linesOver300 = lines.filter((l) => l.length > 300).length
  const sections = sectionsOf(summary)
  // `sectionsOf` substring-matches `[Header]` anywhere, so a brief transcript
  // that merely quotes an omitted header reads as emitted. Emitted header
  // sections always form the summary's FIRST `---`-delimited block (the brief
  // follows), so a genuine section is one whose header opens that block. A
  // quoted `[Session Goal]` heading a brief paragraph sits behind the
  // `[assistant]`/`[user]` line and never opens the block.
  const firstBlock = summary.split(/\n\n---\n\n/)[0] ?? ""
  const policyViolations = (SLICE_OMITTED_SECTIONS as readonly string[]).filter(
    (h) => firstBlock.startsWith(`[${h}]`),
  )

  return {
    slicePathCount: toolPaths.length,
    foundPathCount: found,
    missedPaths: missed,
    inventedPaths: [...new Set(inventedPaths)],
    inventedHashes: [...new Set(inventedHashes)],
    refTotal: refs.length,
    refUnresolvable: [...new Set(refUnresolvable)],
    refOutsideSlice: [...new Set(refOutsideSlice)],
    sliceChars,
    summaryChars,
    compressionPct: sliceChars === 0 ? 0 : (summaryChars / sliceChars) * 100,
    sections,
    policyViolations,
    longestLine,
    linesOver300,
    bash: bashNoise(summary),
    sourceMessageCount: slice.length,
  }
}

// ── scenario construction ──────────────────────────────────────────────────

interface RunResult {
  session: Session
  loaded: Loaded
  globalIndexOk: boolean
  results: ScenarioResult[]
}

const runSession = (session: Session, opts: Options): RunResult | null => {
  const loaded = loadSession(session.file, opts)
  if (loaded.messages.length < opts.minMessages) return null

  const globalIndex = loadCcGlobalIndexByUuid(session.file)
  const globalValues = new Set(globalIndex?.values() ?? [])
  const globalIndexOk = globalIndex !== undefined

  const results: ScenarioResult[] = []
  const n = loaded.messages.length
  const pivots = [...new Set(opts.pivots.map((f) => Math.floor(f * n)))].filter(
    (p) => p > 0 && p < n,
  )

  for (const pivot of pivots) {
    const frames: Array<{ direction: "up_to" | "from"; slice: CcMessage[] }> = [
      // Mirrors the caller's slice notation from the brief: up_to is [0,pivot),
      // from is [pivot,end). The brief's prose also says "keep the pivot out of
      // the summarized side"; the two conflict for `from`, and the explicit
      // slice notation is what the real caller does, so it wins here.
      { direction: "up_to", slice: takeAroundPivot(loaded.messages, pivot, "up_to", opts.sliceChars) },
      { direction: "from", slice: takeAroundPivot(loaded.messages, pivot, "from", opts.sliceChars) },
    ]
    for (const frame of frames) {
      if (frame.slice.length === 0) continue
      const raw = JSON.stringify(frame.slice)
      const sliceIndexSet = new Set<number>()
      for (const m of frame.slice) {
        const idx = m.uuid ? globalIndex?.get(m.uuid) : undefined
        if (idx !== undefined) sliceIndexSet.add(idx)
      }
      const pivotUuid =
        (frame.direction === "up_to"
          ? loaded.messages[pivot - 1]?.uuid
          : loaded.messages[pivot]?.uuid) ?? null

      for (const variant of opts.variants) {
        const out = runVccSliceCompaction({
          messages: frame.slice,
          globalIndexByUuid: globalIndex,
          omitSections: variant === "none" ? [] : undefined,
        })
        const metrics = scoreScenario({
          summary: out.summary,
          slice: frame.slice,
          sliceRawText: raw,
          sliceIndexSet,
          globalValues,
        })
        results.push({
          variant,
          direction: frame.direction,
          pivot,
          pivotUuid,
          summary: out.summary,
          ...metrics,
        })
      }
    }
  }
  return { session, loaded, globalIndexOk, results }
}

// ── reporting ──────────────────────────────────────────────────────────────

const mean = (xs: number[]): number =>
  xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length
const median = (xs: number[]): number => {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
const pct = (x: number): string => `${(x * 100).toFixed(1)}%`
const num = (x: number): string => x.toFixed(1)
const fence = (text: string): string =>
  "````\n" + (text.length ? text : "(empty summary)") + "\n````"

const buildReport = (
  opts: Options,
  sessions: Session[],
  runs: RunResult[],
  startedAt: number,
  elapsedMs: number,
): string => {
  const L: string[] = []
  const allResults = runs.flatMap((r) => r.results)
  const scenarioCount = allResults.length

  L.push("# VCC slice-compaction calibration")
  L.push("")
  L.push(
    "Deterministic measurement of `runVccSliceCompaction` against real session",
  )
  L.push(
    "transcripts. No model or inference call is made: every number is derived",
  )
  L.push("from the session JSONL and the compiled summary text.")
  L.push("")

  // 1. reproduce
  L.push("## 1. How to reproduce")
  L.push("")
  L.push("```bash")
  L.push(`cd ${REPO_ROOT}`)
  L.push(
    "bun run scripts/vcc-slice-calibration.ts" +
      (opts.variants.length === 1 ? ` --variant ${opts.variants[0]}` : "") +
      (opts.only ? ` --only '${opts.only}'` : "") +
      ` --max ${opts.maxSessions}`,
  )
  L.push("```")
  L.push("")
  L.push(`- Corpus: \`${opts.corpus}\` (top-level \`*.jsonl\` only).`)
  L.push(`- Sessions discovered after \`--only\`: ${sessions.length}.`)
  L.push(`- Sessions measured (>= ${opts.minMessages} messages): ${runs.length}.`)
  L.push(
    `- Per-session cap: ${opts.maxMessages} messages / ${opts.maxBytes} raw bytes` +
      ` — sessions hitting a cap: ${runs.filter((r) => r.loaded.capped).length}.`,
  )
  L.push(`- Pivots: ${opts.pivots.join(", ")} of the loaded message list, both directions.`)
  L.push(`- Slice size: <= ${opts.sliceChars.toLocaleString("en-US")} characters of message text, taken outward from each pivot. Slice size is stated in characters, not messages, because one tool result can outweigh a hundred short turns -- a message cap produced spans from 75k to 12M chars, none resembling a production window.`)
  L.push(`- Scenarios scored: ${scenarioCount} (${runs.length} sessions).`)
  L.push(`- Run started: ${new Date(startedAt).toISOString()} (${num(elapsedMs / 1000)} s).`)
  L.push("")
  L.push(
    "Shapes: `up_to` summarizes `[0, pivot)`; `from` summarizes `[pivot, end)`. The",
  )
  L.push(
    "pivot index is a position in the capped message list, so it is reproducible",
  )
  L.push("only together with the cap above.")
  L.push("")

  // 2. aggregate
  L.push("## 2. Aggregate table")
  L.push("")
  L.push(
    "| variant | scenarios | mean file-recall | median file-recall | inventions | unresolvable refs | refs outside slice | mean compression | lines > 300 chars | longest line | bash entries | max bash chars |",
  )
  L.push(
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  )
  for (const variant of opts.variants) {
    const rs = allResults.filter((r) => r.variant === variant)
    // File recall is undefined when a slice named no files; averaging 0 for
    // those would understate recall for small sessions, so they are excluded
    // and the count is reported in the per-session rows.
    const withFiles = rs.filter((r) => r.slicePathCount > 0)
    const recalls = withFiles.map(
      (r) => r.foundPathCount / r.slicePathCount,
    )
    L.push(
      `| ${variant} | ${rs.length} | ${pct(mean(recalls))} | ${pct(median(recalls))} | ` +
        `${rs.reduce((a, r) => a + r.inventedPaths.length + r.inventedHashes.length, 0)} | ` +
        `${rs.reduce((a, r) => a + r.refUnresolvable.length, 0)} | ` +
        `${rs.reduce((a, r) => a + r.refOutsideSlice.length, 0)} | ` +
        `${num(mean(rs.map((r) => r.compressionPct)))}% | ` +
        `${rs.reduce((a, r) => a + r.linesOver300, 0)} | ` +
        `${rs.reduce((a, r) => Math.max(a, r.longestLine), 0)} | ` +
        `${rs.reduce((a, r) => a + r.bash.count, 0)} | ` +
        `${rs.reduce((a, r) => Math.max(a, r.bash.maxChars), 0)} |`,
    )
  }
  L.push("")
  L.push(
    "Mean file-recall excludes scenarios whose slice named zero files (no denominator).",
  )
  L.push("Compression is summary chars / slice chars, lower is better.")
  L.push("")
  L.push(
    "**Policy check** — for the `default` variant `Session Goal` and",
  )
  L.push(
    "`User Preferences` must be absent. Violations across all scenarios: " +
      `${allResults.filter((r) => r.variant === "default" && r.policyViolations.length > 0).length}` +
      " of " +
      `${allResults.filter((r) => r.variant === "default").length}` +
      " (header anchored at line start, so quoted text in the brief does not count).",
  )
  L.push("")
  L.push(
    "The `lines > 300 chars` and `longest line` columns are structurally",
  )
  L.push(
    "degenerate: `compileRanked` runs `wrapLongLines` at 120 chars, so no",
  )
  L.push(
    "physical line can exceed 120. They are kept for completeness; the real",
  )
  L.push(
    "noise signal is the `bash entries` / `max bash chars` columns, which",
  )
  L.push("unwrap each rendered Bash entry (see section 4).")
  L.push("")

  // 3. per-session detail
  L.push("## 3. Per-session detail")
  L.push("")
  for (const run of runs) {
    const capped = run.loaded.capped
      ? ` **CAPPED at ${opts.maxMessages} msgs / ${opts.maxBytes} bytes** (file is ${(run.session.bytes / 1e6).toFixed(1)} MB)`
      : ""
    L.push(
      `### ${basename(run.session.file)} — ${run.loaded.messages.length} messages${capped}`,
    )
    L.push("")
    L.push(`- File: \`${run.session.file}\``)
    L.push(
      `- Session-global index loaded: ${run.globalIndexOk ? "yes" : "NO (refs cannot be checked)"}`,
    )
    L.push("")
    for (const variant of opts.variants) {
      const rs = run.results.filter((r) => r.variant === variant)
      if (rs.length === 0) continue
      L.push(`#### variant \`${variant}\``)
      L.push("")
      L.push(
        "| direction | pivot | pivot uuid | src msgs | slice chars | summary chars | compress | files found | refs (out/unres) | inventions | sections |",
      )
      L.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |")
      for (const r of rs) {
        L.push(
          `| ${r.direction} | ${r.pivot} | \`${(r.pivotUuid ?? "?").slice(0, 8)}\` | ${r.sourceMessageCount} | ` +
            `${r.sliceChars} | ${r.summaryChars} | ${num(r.compressionPct)}% | ` +
            `${r.foundPathCount}/${r.slicePathCount} | ${r.refOutsideSlice.length}/${r.refUnresolvable.length} | ` +
            `${r.inventedPaths.length}+${r.inventedHashes.length}h | ${r.sections.join(", ") || "(none)"} |`,
        )
      }
      L.push("")
      for (const r of rs) {
        L.push(
          `##### ${r.direction} @ pivot ${r.pivot} (variant \`${variant}\`)`,
        )
        if (r.policyViolations.length > 0)
          L.push(
            `> **POLICY VIOLATION**: slice summary claims ${r.policyViolations.join(", ")}.`,
          )
        L.push(
          `- missed files (${r.missedPaths.length}): ` +
            (r.missedPaths.length
              ? r.missedPaths.map((p) => `\`${p}\``).join(", ")
              : "none"),
        )
        if (r.inventedPaths.length)
          L.push(
            `- invented paths: ${r.inventedPaths.map((p) => `\`${p}\``).join(", ")}`,
          )
        if (r.inventedHashes.length)
          L.push(`- invented hashes: ${r.inventedHashes.join(", ")}`)
        if (r.refUnresolvable.length)
          L.push(`- unresolvable refs: ${r.refUnresolvable.map((n) => `#${n}`).join(", ")}`)
        if (r.refOutsideSlice.length)
          L.push(
            `- refs pointing outside the slice: ${r.refOutsideSlice
              .map((n) => `#${n}`)
              .join(", ")}`,
          )
        if (r.bash.count)
          L.push(
            `- bash noise: ${r.bash.count} entries, ${r.bash.totalChars} chars, longest ${r.bash.maxChars}`,
          )
        L.push("")
        if (opts.fullSummaries) L.push(fence(r.summary))
        L.push("")
      }
    }
  }

  // 4. findings (data-driven; an analyst reading follows below)
  L.push("## 4. Findings")
  L.push("")
  const byVariant = (v: string) => allResults.filter((r) => r.variant === v)
  const secCount = (rs: ScenarioResult[], s: string) =>
    rs.filter((r) => r.sections.includes(s)).length
  L.push("### Sections emitted")
  L.push("")
  L.push(
    "Counted with the module's `sectionsOf`, which substring-matches `[Header]`",
  )
  L.push(
    "anywhere — including inside quoted brief text. Treat this as an upper",
  )
  L.push("bound; the policy check above is the anchored one.")
  L.push("")
  L.push("| section | default | none |")
  L.push("| --- | --- | --- |")
  for (const s of [
    "Session Goal",
    "Files And Changes",
    "Commits",
    "Outstanding Context",
    "User Preferences",
  ]) {
    L.push(
      `| ${s} | ${secCount(byVariant("default"), s)} | ${secCount(byVariant("none"), s)} |`,
    )
  }
  L.push("")

  // Pair the two variants on identical scenarios to isolate what omitting the
  // two session-claiming sections actually swallows. `omitSections` splits the
  // summary on `\n\n---\n\n`, but `formatSummary` joins every header section
  // with a plain blank line into ONE block, so the regex only ever sees the
  // first header — and when that header is `Session Goal` the whole header
  // block (Files And Changes, Commits, Outstanding Context) is dropped with it.
  const dropEvidence: string[] = []
  if (opts.variants.includes("default") && opts.variants.includes("none")) {
    let noneHasGoal = 0
    let defaultDroppedAll = 0
    let bothHaveFiles = 0
    let defaultNoFilesButNoneHas = 0
    for (const run of runs) {
      const byKey = new Map<string, ScenarioResult[]>()
      for (const r of run.results)
        byKey.set(`${r.pivot}|${r.direction}`, [...(byKey.get(`${r.pivot}|${r.direction}`) ?? []), r])
      for (const [, rs] of byKey) {
        const d = rs.find((r) => r.variant === "default")
        const n = rs.find((r) => r.variant === "none")
        if (!d || !n) continue
        const noneGoal = n.sections.includes("Session Goal")
        if (noneGoal) noneHasGoal++
        if (noneGoal && !d.sections.includes("Files And Changes")) defaultDroppedAll++
        if (n.sections.includes("Files And Changes"))
          if (d.sections.includes("Files And Changes")) bothHaveFiles++
          else defaultNoFilesButNoneHas++
      }
    }
    dropEvidence.push(
      `- Paired scenarios where \`none\` emits \`Session Goal\`: ${noneHasGoal}.`,
      `- Of those, \`default\` also lost \`Files And Changes\`: ${defaultDroppedAll}.`,
      `- \`none\` emits \`Files And Changes\` in ${bothHaveFiles + defaultNoFilesButNoneHas} scenarios; ` +
        `\`default\` keeps it in ${bothHaveFiles} and drops it in ${defaultNoFilesButNoneHas}.`,
    )
  }
  if (dropEvidence.length) {
    L.push("### Header-block drop under `default`")
    L.push("")
    L.push(...dropEvidence)
    L.push("")
  }

  L.push("### Ref health")
  L.push("")
  const refTotal = (rs: ScenarioResult[]) => rs.reduce((a, r) => a + r.refTotal, 0)
  const unres = (rs: ScenarioResult[]) =>
    rs.reduce((a, r) => a + r.refUnresolvable.length, 0)
  const outside = (rs: ScenarioResult[]) =>
    rs.reduce((a, r) => a + r.refOutsideSlice.length, 0)
  for (const variant of opts.variants) {
    const rs = byVariant(variant)
    L.push(
      `- \`${variant}\`: ${refTotal(rs)} refs, ${unres(rs)} unresolvable, ${outside(rs)} outside slice.`,
    )
  }
  L.push("")

  L.push("### Worst 5 outputs")
  L.push("")
  const score = (r: ScenarioResult): number =>
    r.inventedPaths.length * 10 +
    r.inventedHashes.length * 10 +
    r.refOutsideSlice.length * 5 +
    r.refUnresolvable.length * 5 +
    r.missedPaths.length +
    r.policyViolations.length * 20
  const worst = [...allResults].sort((a, b) => score(b) - score(a)).slice(0, 5)
  for (const r of worst) {
    const sess = runs.find((x) => x.results.includes(r))!
    L.push(
      `- **${basename(sess.session.file)}** ${r.direction}@${r.pivot} (\`${r.variant}\`), defect score ${score(r)}: ` +
        `${r.inventedPaths.length} invented, ${r.refOutsideSlice.length} ref-outside, ` +
        `${r.missedPaths.length} missed${r.policyViolations.length ? `, POLICY ${r.policyViolations.join("/")}` : ""}.`,
    )
  }
  L.push("")
  L.push("### Tool-arg noise")
  L.push("")
  const noisy = [...allResults]
    .filter((r) => r.bash.count > 0)
    .sort((a, b) => b.bash.maxChars - a.bash.maxChars)
    .slice(0, 5)
  for (const r of noisy) {
    const sess = runs.find((x) => x.results.includes(r))!
    L.push(
      `- **${basename(sess.session.file)}** ${r.direction}@${r.pivot} (\`${r.variant}\`): ` +
        `longest rendered bash entry ${r.bash.maxChars} chars.`,
    )
    if (r.bash.worst)
      L.push(`  - \`${r.bash.worst.slice(0, 400)}\``)
  }
  L.push("")

  return L.join("\n")
}

// ── main ───────────────────────────────────────────────────────────────────

const main = (): void => {
  const opts = parseArgs(process.argv.slice(2))
  const startedAt = Date.now()
  const discovered = discoverSessions(opts.corpus, opts.only)
  const sessions = discovered.slice(0, opts.maxSessions)

  const runs: RunResult[] = []
  for (const session of sessions) {
    process.stderr.write(`[vcc-slice] ${basename(session.file)} ...\n`)
    try {
      const r = runSession(session, opts)
      if (r) runs.push(r)
    } catch (err) {
      process.stderr.write(`[vcc-slice] SKIP ${basename(session.file)}: ${err}\n`)
    }
  }

  let report = buildReport(opts, discovered, runs, startedAt, Date.now() - startedAt)
  // A hand-written analysis lives beside the output so a re-run regenerates the
  // measured sections without discarding the reading.
  const appendix = opts.out.replace(/\.md$/, "") + ".appendix.md"
  try {
    report += "\n" + readFileSync(appendix, "utf8")
  } catch {
    // No appendix: the measured report stands alone.
  }
  mkdirSync(dirname(opts.out), { recursive: true })
  writeFileSync(opts.out, report)
  process.stderr.write(
    `[vcc-slice] wrote ${opts.out} (${runs.length} sessions, ` +
      `${runs.reduce((a, r) => a + r.results.length, 0)} scenarios, ` +
      `${((Date.now() - startedAt) / 1000).toFixed(1)}s)\n`,
  )
}

main()
