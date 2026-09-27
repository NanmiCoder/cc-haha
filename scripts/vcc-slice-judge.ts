// Engine-as-judge pass over partial-compaction summaries.
//
// The deterministic harness (vcc-slice-calibration.ts) can count files and refs
// but cannot say whether a summary is *usable*: whether it omits the thing the
// span was about, or states something the span contradicts. This asks the local
// engine to read a span and the summary of it and report that judgement.
//
// Deliberately separate from the calibration harness: that one must stay
// inference-free and runnable at any time; this one costs a model call per case
// and only makes sense on a spread of cases chosen by hand.
//
//   bun run scripts/vcc-slice-judge.ts [--count 8] [--endpoint http://127.0.0.1:8000]
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from 'fs'
import { dirname, join } from 'path'

import { runVccSliceCompaction } from '../src/services/compact/vcc/vccCompact.js'
import { loadCcGlobalIndexByUuid } from '../src/services/compact/vcc/ccGlobalIndex.js'

const args = process.argv.slice(2)
const argOf = (name: string, fallback: string): string => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1]! : fallback
}

const COUNT = Number(argOf('count', '8'))
const ENDPOINT = argOf('endpoint', 'http://127.0.0.1:8000')
const MODEL = argOf('model', 'zxsv-ai')
const CORPUS = '/home/zeaxion/.claude/projects'
// Anchored to this file's own tree: the repo's preload chdirs to the caller's
// directory, so a relative output path lands outside the repo depending on
// where the script was invoked from.
const REPO_ROOT = join(dirname(import.meta.dir), '.')
const OUT = join(REPO_ROOT, 'modify/reports/vcc-slice-judge.md')

// A span is far larger than the judge can read, so it is bounded head+tail with
// the elision stated in the prompt. Enough to judge whether the summary covers
// what the span was about, which is a different question from "did it name
// every file" (the deterministic pass owns that).
// How much of the span the judge reads. The judge answers "does the summary
// represent the span", so the span is the ground truth and in principle all of
// it belongs in the prompt. But a very long prompt is not free: a smaller judge
// model attends to less of it, and the chosen budget moves the verdict, so it
// is a knob to be set deliberately (and held fixed across a comparison) rather
// than a constant pulled from the air. Override with --transcript-budget.
const TRANSCRIPT_BUDGET = Number(argOf('transcript-budget', '120000'))
const PER_MESSAGE_CHARS = 400

// A production partial compaction runs over the live window, which is bounded by
// the auto-compact threshold — not over a whole 24k-message session. Taking the
// pivot-outward 600 keeps the sampled slice at the size the feature actually
// meets, so the judge is not judging a view that only exists in a harness.
// Slice size, in the characters the compactor actually sees. Kept far below the
// production figure on purpose: this harness must hand the judge a span it can
// read in full, and the judge is a ~200k-token engine that also has to produce
// the verdict. A production slice (~750k chars) would leave no room for the
// answer and force elision, which measures the judge's attention rather than the
// summary. So the two harnesses divide the work:
//   - this one asks "is the summary *usable*", on spans it can read whole;
//   - `vcc-slice-calibration.ts` asks "what survives at production size", which
//     is deterministic and so has no such limit.
// Override with --slice-chars, but a larger value costs the judge its full view.
const SLICE_MAX_CHARS = Number(argOf('slice-chars', '60000'))

/** Roughly the text of one message, for size accounting only. */
const messageChars = (m: Cc): number => {
  const c = m.message?.content
  if (typeof c === 'string') return c.length
  if (!Array.isArray(c)) return 0
  let n = 0
  for (const b of c) {
    if (typeof b?.text === 'string') n += b.text.length
    else if (typeof b?.thinking === 'string') n += b.thinking.length
    else if (b?.type === 'tool_use') n += JSON.stringify(b.input ?? {}).length
    else if (b?.type === 'tool_result') {
      n += typeof b.content === 'string' ? b.content.length : JSON.stringify(b.content ?? '').length
    }
  }
  return n
}

/**
 * Take the messages adjacent to the pivot, up to a character budget. Adjacent
 * rather than from the edge: the pivot is where a reader chose to split, so the
 * messages nearest it are the ones the summary is most about. At least one
 * message is always taken, so one oversized message yields a one-message slice
 * rather than an empty one.
 */
const takeAroundPivot = (messages: Cc[], pivot: number, direction: 'up_to' | 'from', budget: number): Cc[] => {
  if (budget <= 0) {
    return direction === 'up_to' ? messages.slice(0, pivot) : messages.slice(pivot)
  }
  const out: Cc[] = []
  let used = 0
  if (direction === 'up_to') {
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

type Cc = { type: string; uuid?: string; message?: any; timestamp?: string }

const linesOf = (file: string): Cc[] => {
  const out: Cc[] = []
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue
    try {
      const o = JSON.parse(line) as Cc
      if ((o.type === 'user' || o.type === 'assistant') && o.message) out.push(o)
    } catch {
      // A corrupt line is not a message; skipping keeps the index aligned with
      // ccGlobalIndex, which also drops unparseable lines.
    }
  }
  return out
}

const clip = (text: string, limit = PER_MESSAGE_CHARS): string =>
  text.length <= limit ? text : `${text.slice(0, limit)}…[${text.length - limit} more chars]`

/** Render a span readably; the judge needs prose, not JSON. */
const render = (messages: Cc[]): string => {
  const parts: string[] = []
  for (const m of messages) {
    const role = m.type === 'user' ? 'user' : 'assistant'
    const content = m.message?.content
    if (typeof content === 'string') {
      parts.push(`[${role}] ${clip(content)}`)
      continue
    }
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (block?.type === 'text') parts.push(`[${role}] ${clip(block.text ?? '')}`)
      else if (block?.type === 'thinking') parts.push(`[thinking] ${clip(block.thinking ?? '')}`)
      else if (block?.type === 'tool_use') {
        parts.push(`* Tool "${block.name}" ${clip(JSON.stringify(block.input ?? {}), 300)}`)
      } else if (block?.type === 'tool_result') {
        const text = typeof block.content === 'string'
          ? block.content
          : JSON.stringify(block.content ?? '')
        parts.push(`  → ${clip(text, 300)}`)
      }
    }
  }
  const joined = parts.join('\n')
  if (joined.length <= TRANSCRIPT_BUDGET) return joined
  // Head and tail both matter: a span's goal is usually at its start and its
  // outcome at its end.
  const head = Math.floor(TRANSCRIPT_BUDGET * 0.4)
  const tail = TRANSCRIPT_BUDGET - head
  const dropped = joined.length - head - tail
  return `${joined.slice(0, head)}\n\n…[${dropped} chars elided from the middle]…\n\n${joined.slice(-tail)}`
}

// ── Hypothesis probe: would the span's own conclusions help? ────────────────
// The compiled summary carries structure (files, commits, blockers) and a tool
// log, but no channel for what the assistant concluded. A reader cannot recover
// a root cause, what a fix was, or a test result from a file list. `appendEndState`
// already quotes only the span's *last* assistant paragraph, which is one
// sentence against a whole span. This probe appends the span's segment-closing
// paragraphs -- stated verbatim, so nothing is inferred -- to test whether the
// hypothesis is worth implementing in the compiler at all.
const AUGMENT_CONCLUSIONS = args.includes('--augment-conclusions')
const EMBED_SUMMARIES = args.includes('--embed-summaries')

const closingConclusions = (messages: Cc[]): string[] => {
  const out: string[] = []
  for (let i = 0; i < messages.length; i++) {
    const content = messages[i].message?.content
    if (messages[i].type !== 'assistant' || !Array.isArray(content)) continue
    const text = content
      .filter((b: any) => b?.type === 'text' && typeof b.text === 'string')
      .map((b: any) => b.text as string)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (text.length < 120) continue
    // Segment-closing: the next non-tool-result message is a user turn (or none).
    let next: Cc | undefined
    for (let j = i + 1; j < messages.length; j++) {
      const c = messages[j].message?.content
      const isResult = Array.isArray(c) && c.some((b: any) => b?.type === 'tool_result')
      if (!isResult) { next = messages[j]; break }
    }
    if (next && next.type !== 'user') continue
    out.push(text.length > 500 ? `${text.slice(0, 500)}…` : text)
  }
  return out
}

const PROMPT = (transcript: string, summary: string): string => `You are reviewing one internal summary of a slice of a coding session.

Context you need to judge it fairly:
- The slice below is a *part* of a session. The other part is kept verbatim outside this summary, so the summary neither needs nor is allowed to describe it.
- The summary replaces the slice in the model's context. A reader who never sees the slice must be able to continue work from the summary alone.
- Short, structured, terse summaries are intended. Do NOT penalise brevity, bullet form, file lists, or terseness.
- Do NOT penalise the absence of things the slice never contains.

Report only real problems. Quote exact text when you flag something.

Answer with JSON only, no prose around it:
{
  "coverage": 1-5,        // how much of what the slice was actually about survives
  "missing": ["..."],     // most important things a reader would need and cannot get, most important first
  "falseClaims": ["..."], // statements the slice contradicts or does not support (quote them)
  "misleading": ["..."],  // statements that are technically true but would misdirect the reader
  "readability": 1-5,     // can a reader act on it
  "verdict": "usable" | "needs-work"
}

--- SLICE (what must be represented) ---
${transcript}

--- SUMMARY (what will represent it) ---
${summary}
`

const judge = async (
  transcript: string,
  summary: string,
): Promise<{ ok: boolean; raw: string }> => {
  const res = await fetch(`${ENDPOINT}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: 'user', content: PROMPT(transcript, summary) }],
      temperature: 0,
      // Generous on purpose: the verdict is a JSON object whose `missing` and
      // `misleading` arrays are routinely dozens of entries, and the old 1500
      // cut them off mid-object -- `extractJson` then parsed a truncated
      // fragment, so the tally under-reported what the judge actually found.
      // The cap only binds if the answer would exceed it; it does not make a
      // short answer longer.
      max_tokens: 32768,
      // Thinking off on purpose: the verdict is what is wanted, and on a
      // 120k-char prompt this build otherwise reasons until the allowance is
      // gone and the judgement never arrives.
      chat_template_kwargs: { enable_thinking: false },
    }),
    signal: AbortSignal.timeout(300_000),
  })
  if (!res.ok) return { ok: false, raw: `HTTP ${res.status}: ${(await res.text()).slice(0, 300)}` }
  const body = (await res.json()) as any
  const choice = body?.choices?.[0]
  const message = choice?.message ?? {}
  const content = typeof message.content === 'string' && message.content.trim() !== ''
    ? message.content
    // A reasoning build can spend the whole allowance thinking and come back
    // with `content: null`; the answer is then in `reasoning` (this engine) or
    // `reasoning_content` (vLLM's usual key).
    : message.reasoning ?? message.reasoning_content ?? null
  if (typeof content !== 'string' || content.trim() === '') {
    return {
      ok: false,
      raw: `empty content (finish_reason=${choice?.finish_reason}, completion_tokens=${body?.usage?.completion_tokens})`,
    }
  }
  return { ok: true, raw: content }
}

const extractJson = (text: string): any | null => {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    return JSON.parse(text.slice(start, end + 1))
  } catch {
    return null
  }
}

// Sessions largest-first, so the sampled cases are the ones with real content.
const sessions = readdirSync(CORPUS)
  .flatMap((dir) => {
    const full = join(CORPUS, dir)
    try {
      if (!statSync(full).isDirectory()) return []
      return readdirSync(full)
        .filter((f) => f.endsWith('.jsonl'))
        .map((f) => join(full, f))
    } catch {
      return []
    }
  })
  .map((file) => ({ file, size: statSync(file).size }))
  .sort((a, b) => b.size - a.size)
  .slice(0, COUNT * 2)

// ── Sample pinning ──────────────────────────────────────────────────────────
// Candidates are the largest sessions by file size, and those files keep growing
// while work continues. A second run therefore draws a *different* set of spans,
// and its totals cannot be compared with the first run's -- which is exactly the
// mistake this pinning exists to prevent: an apparent movement in coverage can
// be nothing but a change of subject. The chosen sample is frozen to a file and
// reused, so two measurements differ only by the code under test.
const SAMPLE_PATH = join(REPO_ROOT, 'modify/reports/vcc-slice-judge.sample.json')

type SampleEntry = { file: string; direction: 'up_to' | 'from'; pivot: number; messages: number }

const planSample = (): SampleEntry[] => {
  const out: SampleEntry[] = []
  for (const [i, session] of sessions.entries()) {
    if (out.length >= COUNT) break
    const messages = linesOf(session.file)
    // A session shorter than the floor cannot yield a substantial slice.
    if (messages.length < 120) continue
    out.push({
      file: session.file,
      // Alternate direction so both sides of a pivot are represented, and pivot
      // well inside the session so each slice is substantial.
      direction: i % 2 === 0 ? 'up_to' : 'from',
      pivot: Math.floor(messages.length * 0.6),
      messages: messages.length,
    })
  }
  return out
}

const readPinnedSample = (): SampleEntry[] | null => {
  if (args.includes('--resample')) return null
  try {
    const parsed = JSON.parse(readFileSync(SAMPLE_PATH, 'utf8')) as SampleEntry[]
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : null
  } catch {
    return null // first run, or the file is mid-write
  }
}

async function main() {
  const pinned = readPinnedSample()
  let sample: SampleEntry[]
  if (pinned) {
    sample = pinned.filter((entry) => existsSync(entry.file))
    console.log(`[judge] using pinned sample ${SAMPLE_PATH} (${sample.length}/${pinned.length} spans still readable)`)
  } else {
    sample = planSample()
    writeFileSync(SAMPLE_PATH, `${JSON.stringify(sample, null, 2)}\n`)
    console.log(`[judge] pinned a new sample of ${sample.length} spans to ${SAMPLE_PATH}`)
  }

  const cases: string[] = []
  for (const entry of sample) {
    const { file: sessionFile, direction, pivot } = entry
    const messages = linesOf(sessionFile)
    if (messages.length <= pivot) {
      console.log(`[judge] ${sessionFile.split('/').pop()} ${direction}@${pivot}: skipped (transcript shrank below the pinned pivot)`)
      continue
    }
    // Pivot outward: the 600 messages adjacent to the pivot, which is the
    // neighbourhood a person actually picks a pivot in.
    const slice = takeAroundPivot(messages, pivot, direction, SLICE_MAX_CHARS)

    const globalIndexByUuid = loadCcGlobalIndexByUuid(sessionFile)
    let result
    try {
      result = runVccSliceCompaction({ messages: slice as never, globalIndexByUuid })
    } catch (error) {
      console.log(`[judge] ${sessionFile.split('/').pop()} ${direction}@${pivot}: compaction threw — ${(error as Error).message}`)
      continue
    }

    const name = sessionFile.split('/').pop()!
    const rendered = render(slice)
    console.log(`[judge] ${name} ${direction}@${pivot} slice=${slice.length} msgs → span ${rendered.length} chars (budget ${TRANSCRIPT_BUDGET}${rendered.length > TRANSCRIPT_BUDGET ? ', ELIDED' : ''}) → summary ${result.summary.length} chars`)
    const summaryUnderReview = AUGMENT_CONCLUSIONS
      ? (() => {
          const notes = closingConclusions(slice)
          if (notes.length === 0) return result.summary
          return `${result.summary}\n\n[Concluding Notes]\n${notes.map((n) => `- ${n}`).join('\n')}`
        })()
      : result.summary
    const judged = await judge(render(slice), summaryUnderReview)
    const parsed = judged.ok ? extractJson(judged.raw) : null
    cases.push(
      [
        `### ${name} — ${direction}@${pivot}`,
        '',
        `- Slice: ${slice.length} messages (pivot-outward, <=${SLICE_MAX_CHARS} chars), ${render(slice).length} chars rendered · Summary: ${result.summary.length} chars · compression ${(result.summary.length / render(slice).length * 100).toFixed(1)}%`,
        `- Sections: ${JSON.stringify(result.sections)}`,
        judged.ok
          ? `- Judge: ${parsed ? '```json\n' + JSON.stringify(parsed, null, 2) + '\n```' : 'raw: ' + judged.raw.slice(0, 1200)}`
          : `- Judge FAILED: ${judged.raw}`,
        '',
        // The summary under review is off by default: it quotes the session it
        // was compiled from, so committing the report would publish transcripts.
        // The verdicts below stay -- they are the measurement. Opt in with
        // --embed-summaries when the summary text itself is what is being read.
        ...(EMBED_SUMMARIES
          ? ['<details><summary>summary under review</summary>', '', '````', result.summary, '````', '', '</details>', '']
          : []),
      ].join('\n'),
    )
  }

  const header = [
    '# Engine judgement of partial-compaction summaries',
    '',
    `Local engine \`${MODEL}\` at ${ENDPOINT}. ${cases.length} cases sampled from the largest sessions, alternating the pivot direction.`,
    '',
    'The engine sees the same span the compactor did and is asked to report coverage,',
    'unsupported statements and misdirection. It is a reading, not a measurement: the',
    'deterministic numbers live in `vcc-slice-calibration.md`.',
    '',
    '```',
    `bun run scripts/vcc-slice-judge.ts --count ${COUNT}`,
    '```',
    '',
    '---',
    '',
  ].join('\n')

  writeFileSync(OUT, header + cases.join('\n'))
  console.log(`[judge] wrote ${OUT} (${cases.length} cases)`)
}

void main()
