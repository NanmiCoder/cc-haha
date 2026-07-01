/**
 * sessionSummaryService — produce and cache a compact two-layer summary
 * (project-level + recent-detailed) of a session's transcript so that the
 * NEXT session in the same project can be auto-bootstrapped with hand-off
 * context, without paying tokens to re-feed the entire prior transcript.
 *
 * Token economics:
 *   - Generation: one LLM call per session, capped at ~1500 output tokens.
 *     Cached on disk (~/.claude/projects/<proj>/<sessionId>.summary.json).
 *   - Reuse: the cached summary is injected into the next session via
 *     `--append-system-prompt` at CLI launch (no per-session-start token
 *     cost beyond the one-time generation that's amortized across continues).
 *
 * Failure mode: any error here is swallowed by the caller — the welcome
 * screen falls back to the existing zero-token "Continue from here"
 * paragraph. The handoff feature is never load-bearing.
 */

import { promises as fs } from 'node:fs'
import { createReadStream } from 'node:fs'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { ProviderService } from './providerService.js'
import { sessionService } from './sessionService.js'
import {
  isOpenAIOfficialProviderId,
} from './openaiOfficialProvider.js'
import { hahaOpenAIOAuthService } from './hahaOpenAIOAuthService.js'
import { OPENAI_CODEX_API_ENDPOINT } from '../../services/openaiAuth/client.js'
import { resolveOpenAICodexModel } from '../../services/openaiAuth/models.js'
import { anthropicToOpenaiResponses } from '../proxy/transform/anthropicToOpenaiResponses.js'
import { openaiResponsesStreamToAnthropicResponse } from '../proxy/streaming/openaiResponsesStreamToAnthropicResponse.js'

export type SessionSummary = {
  /** The session this summary describes. */
  sessionId: string
  /** ISO timestamp of when this summary was generated. */
  generatedAt: string
  /** Total assistant+user message count when this summary was generated.
   *  Used for staleness detection — if the live count drifts higher, the
   *  summary is considered stale and re-generated. */
  baseMessageCount: number
  /** The provider:model identifier used to generate this summary. */
  modelUsed: string
  /** ~300-500 tok project-level summary: what was the session about, what
   *  was achieved, what's the high-level state right now. */
  main: string
  /** ~600-1000 tok detailed summary of the most recent ~10 turns: what was
   *  decided, what was tried, what's pending right now. */
  recent: string
  /**
   * Raw (truncated) tail of the transcript — the LAST ~24 turns rendered
   * as `USER: …` / `ASSISTANT: …` lines, each truncated to ~600 chars,
   * total capped at ~16000 chars. Lets the next-session AI see the actual
   * recent wording (what the user literally just asked, what was actually
   * said about the failure mode) instead of relying solely on the LLM's
   * abstracted `recent` summary, which tends to lose proper nouns,
   * specific error messages, and the user's exact phrasing.
   *
   * Bumped from 12/400/8000 in v0.5.10: real-world handoffs were
   * dropping the latest "what went wrong / what we tried" exchange
   * because the previous tail covered ~6 user-AI pairs, which often
   * predates the most recent debugging detour. The new defaults add
   * ~2k tokens to the handoff system prompt — negligible against
   * modern 200k+ context windows.
   *
   * Optional for backward compat: older cache files without this field
   * still load — `formatHandoffSystemPrompt` just omits the raw section.
   */
  recentRaw?: string
  /** Best-effort token accounting for cost transparency. */
  tokensIn?: number
  tokensOut?: number
}

const SUMMARY_OUTPUT_MAX_TOKENS_DEFAULT = 1500
const SUMMARY_INPUT_MAX_CHARS_DEFAULT = 80_000
const SUMMARY_REQUEST_TIMEOUT_MS = 60_000
const SUMMARY_FILE_SUFFIX = '.summary.json'

/**
 * How many trailing turns (USER+ASSISTANT lines) to keep verbatim in the
 * `recentRaw` slice. 24 turns ≈ 12 user/AI exchange pairs, enough to
 * cover the most recent debugging detour AND the prior context that
 * usually frames it ("we tried A, then B failed because…, so I want to
 * try C"). Bumped from 12 in v0.5.10 after handoffs kept losing the
 * latest "what went wrong" beat. Override with
 * CLAUDE_CODE_HANDOFF_RAW_TURNS (env cap 80).
 */
const SUMMARY_RAW_TAIL_TURNS_DEFAULT = 24
/**
 * Per-turn char cap. 600 keeps a typical assistant code-explanation
 * paragraph intact; below ~500 the tail block tends to clip just before
 * the actionable verb ("so the next step is to…").
 */
const SUMMARY_RAW_TAIL_CHARS_PER_TURN_DEFAULT = 600
/**
 * Total cap on the raw block. ~16k chars ≈ 4k tokens — still ~1% of a
 * 200k-window provider, but enough that a 24-turn × 600-char tail
 * doesn't have to drop older turns on dense conversations.
 */
const SUMMARY_RAW_TAIL_TOTAL_CHARS_DEFAULT = 16_000

function getOutputCap(): number {
  const raw = process.env.CLAUDE_CODE_HANDOFF_MAX_TOKENS
  if (!raw) return SUMMARY_OUTPUT_MAX_TOKENS_DEFAULT
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed < 200) return SUMMARY_OUTPUT_MAX_TOKENS_DEFAULT
  return Math.min(parsed, 4000)
}

function getInputCap(): number {
  const raw = process.env.CLAUDE_CODE_HANDOFF_INPUT_CHARS
  if (!raw) return SUMMARY_INPUT_MAX_CHARS_DEFAULT
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed < 5_000) return SUMMARY_INPUT_MAX_CHARS_DEFAULT
  return parsed
}

function getRawTailTurns(): number {
  const raw = process.env.CLAUDE_CODE_HANDOFF_RAW_TURNS
  if (!raw) return SUMMARY_RAW_TAIL_TURNS_DEFAULT
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed < 0) return SUMMARY_RAW_TAIL_TURNS_DEFAULT
  return Math.min(parsed, 80)
}

function getRawTailTotalChars(): number {
  const raw = process.env.CLAUDE_CODE_HANDOFF_RAW_CHARS
  if (!raw) return SUMMARY_RAW_TAIL_TOTAL_CHARS_DEFAULT
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed < 500) return SUMMARY_RAW_TAIL_TOTAL_CHARS_DEFAULT
  return Math.min(parsed, 50_000)
}

/** Truncate a single turn line preserving the role prefix. */
function truncateTurnLine(line: string, maxChars: number): string {
  if (line.length <= maxChars) return line
  // Try to keep the `USER: ` / `ASSISTANT: ` prefix intact; only truncate
  // the body. If the line is shorter than the prefix budget anyway, the
  // outer length check already returned.
  const colonIdx = line.indexOf(': ')
  if (colonIdx > 0 && colonIdx < 16) {
    const prefix = line.slice(0, colonIdx + 2)
    const body = line.slice(colonIdx + 2)
    const room = Math.max(0, maxChars - prefix.length - 1)
    return prefix + body.slice(0, room).trimEnd() + '…'
  }
  return line.slice(0, maxChars - 1).trimEnd() + '…'
}

/**
 * Build the verbatim-but-truncated tail slice of the transcript. Caller
 * inserts this into the hand-off system prompt under "Most recent
 * messages (verbatim, truncated)" so the next-session AI can see the
 * actual user wording — not just the LLM-summarized abstract.
 */
/**
 * Hard-coded "deep handoff" sizing used when the user explicitly toggles
 * deep mode in the welcome card. Deliberately fixed (not env-driven) so
 * the toggle has predictable behavior — a user picking deep gets the
 * same enlarged tail regardless of any CLAUDE_CODE_HANDOFF_RAW_*
 * overrides the env may carry. Deep mode adds ~12k tokens to the handoff
 * system prompt; still ~6% of a 200k window.
 */
const SUMMARY_RAW_TAIL_DEEP_TURNS = 60
const SUMMARY_RAW_TAIL_DEEP_CHARS_PER_TURN = 800
const SUMMARY_RAW_TAIL_DEEP_TOTAL_CHARS = 50_000

/**
 * Pure slicing helper: produce the verbatim tail from a turns[] array
 * given explicit sizing. Older turns drop first when the per-turn cap
 * still busts the total cap.
 */
function buildRecentRawSliceWithSizes(
  turns: string[],
  sizes: { tailTurns: number; perTurn: number; totalCap: number },
): string {
  const { tailTurns, perTurn, totalCap } = sizes
  if (tailTurns === 0 || turns.length === 0) return ''
  const start = Math.max(0, turns.length - tailTurns)
  const candidates = turns.slice(start).map((t) => truncateTurnLine(t, perTurn))
  let total = 0
  const kept: string[] = []
  for (let i = candidates.length - 1; i >= 0; i--) {
    const t = candidates[i]!
    if (total + t.length + 2 > totalCap && kept.length > 0) break
    kept.unshift(t)
    total += t.length + 2
  }
  return kept.join('\n\n')
}

/**
 * Build the verbatim-but-truncated tail slice of the transcript. Caller
 * inserts this into the hand-off system prompt under "Most recent
 * messages (verbatim, truncated)" so the next-session AI can see the
 * actual user wording — not just the LLM-summarized abstract.
 */
function buildRecentRawSlice(turns: string[]): string {
  return buildRecentRawSliceWithSizes(turns, {
    tailTurns: getRawTailTurns(),
    perTurn: SUMMARY_RAW_TAIL_CHARS_PER_TURN_DEFAULT,
    totalCap: getRawTailTotalChars(),
  })
}

const SUMMARY_SYSTEM_PROMPT = `You are summarizing a coding-agent conversation between a developer and an AI assistant. The summary will be injected as system-level hand-off context into the developer's NEXT session in the same project, so the next-session AI knows what was already discussed without re-feeding the whole transcript.

Output STRICT JSON with exactly two string fields and nothing else:
{
  "main": "...",
  "recent": "..."
}

"main" — 2-4 paragraphs. Project-level overview. What was the session ABOUT, what concrete things were AGREED / BUILT / DECIDED, and what is the high-level state right now (e.g. "branch X, N commits ahead, tests passing"). Aim ~300-450 tokens. Skip sycophancy and tool-call mechanics.

"recent" — Detailed summary of the LAST ~5-10 substantive turns. What did the user ask, what did the AI propose, what was tried, what was rejected, what is currently pending or in-progress. Aim ~500-900 tokens. Be concrete: name files, branches, function names, error messages where relevant.

Both fields together MUST stay under the model's output budget. Output ONLY the JSON object — no preamble, no markdown fence, no commentary.`

const SUMMARY_USER_PROMPT_PREFIX =
  'Summarize the following conversation. Output JSON as instructed.\n\n--- TRANSCRIPT ---\n'

/**
 * Walk a session JSONL and produce a compact transcript text. Order is
 * chronological. We tail-slice to `INPUT_CAP` characters by keeping the
 * MOST RECENT content (recent context dominates for hand-off). Tool uses
 * are summarized to one-liners so the LLM sees what was DONE without
 * us paying for full tool result bodies.
 */
async function buildTranscriptText(filePath: string): Promise<{
  text: string
  messageCount: number
  recentRaw: string
}> {
  const inputCap = getInputCap()
  const turns = await readTurnsFromTranscript(filePath)
  const messageCount = turns.length

  // Tail-slice: keep the most recent turns until we're under cap. Recent
  // context dominates the hand-off value, so older turns are dropped first.
  let total = 0
  const kept: string[] = []
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i]!
    if (total + t.length + 2 > inputCap && kept.length > 0) break
    kept.unshift(t)
    total += t.length + 2
  }

  // Independent of the LLM-summarization tail, also derive the verbatim
  // (truncated) recent slice that ships with the summary into the next
  // session's system prompt. Computed off the FULL `turns` so the per-turn
  // truncation logic doesn't interact with the summarization input cap.
  const recentRaw = buildRecentRawSlice(turns)

  return {
    text: kept.join('\n\n'),
    messageCount,
    recentRaw,
  }
}

/**
 * Read JSONL transcript and produce the chronological `USER:` /
 * `ASSISTANT:` lines used by both the LLM-summarization input and the
 * verbatim recentRaw slice. Extracted so the deep-handoff rebuild path
 * can reuse parsing without re-running the LLM summarization pipeline.
 */
async function readTurnsFromTranscript(filePath: string): Promise<string[]> {
  const stream = createReadStream(filePath, { encoding: 'utf8' })
  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  const turns: string[] = []
  try {
    for await (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      let entry: Record<string, unknown>
      try {
        entry = JSON.parse(trimmed) as Record<string, unknown>
      } catch {
        continue
      }
      if (entry.isMeta === true) continue

      if (entry.type === 'user') {
        const message = entry.message as { content?: unknown } | undefined
        const text = extractTextFromContent(message?.content)
        if (text) turns.push(`USER: ${text}`)
        continue
      }

      if (entry.type === 'assistant') {
        const message = entry.message as { content?: unknown } | undefined
        const blocks = Array.isArray(message?.content)
          ? (message.content as Array<Record<string, unknown>>)
          : []
        const parts: string[] = []
        for (const block of blocks) {
          if (block.type === 'text' && typeof block.text === 'string') {
            const t = block.text.trim()
            if (t) parts.push(t)
          } else if (block.type === 'tool_use') {
            parts.push(formatToolUseSummary(block))
          }
        }
        if (parts.length > 0) turns.push(`ASSISTANT: ${parts.join('\n')}`)
      }
    }
  } finally {
    lines.close()
    stream.destroy()
  }
  return turns
}

function extractTextFromContent(content: unknown): string {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (block && typeof block === 'object') {
      const b = block as Record<string, unknown>
      if (b.type === 'text' && typeof b.text === 'string') {
        const t = b.text.trim()
        if (t) parts.push(t)
      }
    }
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim()
}

function formatToolUseSummary(block: Record<string, unknown>): string {
  const name = typeof block.name === 'string' ? block.name : 'tool'
  const input = block.input as Record<string, unknown> | undefined
  if (!input) return `[tool: ${name}]`

  // Keep this terse — we don't want to spend the input budget on tool-call
  // mechanics. Just enough for the LLM to know "an edit happened to file X"
  // or "a Bash command ran".
  if (typeof input.file_path === 'string') {
    return `[tool: ${name} file: ${input.file_path}]`
  }
  if (typeof input.notebook_path === 'string') {
    return `[tool: ${name} notebook: ${input.notebook_path}]`
  }
  if (name === 'Bash' && typeof input.command === 'string') {
    const cmd = input.command.length > 120 ? input.command.slice(0, 117) + '…' : input.command
    return `[tool: Bash $ ${cmd}]`
  }
  if ((name === 'Agent' || name === 'Task') && typeof input.subagent_type === 'string') {
    const desc = typeof input.description === 'string' ? input.description : ''
    return `[tool: Agent → ${input.subagent_type}${desc ? ` "${desc}"` : ''}]`
  }
  return `[tool: ${name}]`
}

/**
 * Resolve the (provider, model) to invoke for summarization. Mirrors
 * titleService.ts: prefer the active provider's haiku/cheap model, fall
 * back to its main model. Returns null if no usable provider is configured
 * (caller falls back to no-summary mode).
 */
async function resolveSummarizationTarget(): Promise<
  | { kind: 'anthropic'; baseUrl: string; apiKey: string; model: string }
  | { kind: 'openai-codex'; model: string }
  | null
> {
  const providerService = new ProviderService()
  const { activeId, providers } = await providerService.listProviders()

  let resolved = activeId
    ? isOpenAIOfficialProviderId(activeId)
      ? await providerService.getProvider(activeId)
      : providers.find((p) => p.id === activeId) ?? null
    : null

  if (resolved && isOpenAIOfficialProviderId(resolved.id)) {
    return {
      kind: 'openai-codex',
      model: resolveOpenAICodexModel(resolved.models.haiku || resolved.models.main),
    }
  }

  if (!resolved?.baseUrl || !resolved?.apiKey) return null
  const model = resolved.models.haiku || resolved.models.main
  if (!model) return null

  return {
    kind: 'anthropic',
    baseUrl: resolved.baseUrl,
    apiKey: resolved.apiKey,
    model,
  }
}

function tryParseSummaryResponse(text: string): { main: string; recent: string } | null {
  // Strip code fences if the model returned ```json ... ``` despite asking for raw JSON.
  let normalized = text.trim()
  if (normalized.startsWith('```')) {
    normalized = normalized
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/```\s*$/i, '')
      .trim()
  }
  // Find the first balanced JSON object — defensive for "preamble + JSON" replies.
  const start = normalized.indexOf('{')
  const end = normalized.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  const body = normalized.slice(start, end + 1)
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const obj = parsed as Record<string, unknown>
  const main = typeof obj.main === 'string' ? obj.main.trim() : ''
  const recent = typeof obj.recent === 'string' ? obj.recent.trim() : ''
  if (!main || !recent) return null
  return { main, recent }
}

async function callSummarizer(
  target: NonNullable<Awaited<ReturnType<typeof resolveSummarizationTarget>>>,
  transcript: string,
): Promise<{ raw: string; tokensIn?: number; tokensOut?: number } | null> {
  const userPrompt = `${SUMMARY_USER_PROMPT_PREFIX}${transcript}\n\n--- END TRANSCRIPT ---`

  if (target.kind === 'anthropic') {
    const url = `${target.baseUrl.replace(/\/+$/, '')}/v1/messages`
    const body = {
      model: target.model,
      max_tokens: getOutputCap(),
      system: SUMMARY_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
      thinking: { type: 'disabled' },
    }
    const headers = {
      'Content-Type': 'application/json',
      'x-api-key': target.apiKey,
      'anthropic-version': '2023-06-01',
    }
    let response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(SUMMARY_REQUEST_TIMEOUT_MS),
    })
    // Some proxies reject the `thinking` field; retry without it on 4xx.
    if (!response.ok && response.status >= 400 && response.status < 500) {
      const retryBody = { ...body }
      delete (retryBody as { thinking?: unknown }).thinking
      response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(retryBody),
        signal: AbortSignal.timeout(SUMMARY_REQUEST_TIMEOUT_MS),
      })
    }
    if (!response.ok) return null
    const json = (await response.json()) as {
      content?: Array<{ type: string; text?: string }>
      usage?: { input_tokens?: number; output_tokens?: number }
    }
    const text = json.content?.find((b) => b.type === 'text')?.text
    if (!text) return null
    return {
      raw: text,
      ...(typeof json.usage?.input_tokens === 'number' ? { tokensIn: json.usage.input_tokens } : {}),
      ...(typeof json.usage?.output_tokens === 'number' ? { tokensOut: json.usage.output_tokens } : {}),
    }
  }

  // OpenAI Codex (ChatGPT OAuth) path.
  const tokens = await hahaOpenAIOAuthService.ensureFreshTokens()
  if (!tokens?.accessToken) return null
  const requestBody = anthropicToOpenaiResponses({
    model: target.model,
    max_tokens: getOutputCap(),
    system: SUMMARY_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userPrompt }],
    stream: true,
    thinking: { type: 'disabled' },
  })
  requestBody.stream = true
  requestBody.max_output_tokens = getOutputCap()
  const headers = new Headers()
  headers.set('Content-Type', 'application/json')
  headers.set('Authorization', `Bearer ${tokens.accessToken}`)
  if (tokens.accountId) {
    headers.set('ChatGPT-Account-Id', tokens.accountId)
  }
  const response = await fetch(OPENAI_CODEX_API_ENDPOINT, {
    method: 'POST',
    headers,
    body: JSON.stringify(requestBody),
    signal: AbortSignal.timeout(SUMMARY_REQUEST_TIMEOUT_MS),
  })
  if (!response.ok || !response.body) return null
  const body = await openaiResponsesStreamToAnthropicResponse(response.body, target.model)
  const text = body.content.find((b) => b.type === 'text')?.text
  if (!text) return null
  return {
    raw: text,
    ...(typeof body.usage?.input_tokens === 'number' ? { tokensIn: body.usage.input_tokens } : {}),
    ...(typeof body.usage?.output_tokens === 'number' ? { tokensOut: body.usage.output_tokens } : {}),
  }
}

function summaryFilePathFor(jsonlPath: string): string {
  return jsonlPath.replace(/\.jsonl$/i, SUMMARY_FILE_SUFFIX)
}

async function readCachedSummary(summaryPath: string): Promise<SessionSummary | null> {
  try {
    const raw = await fs.readFile(summaryPath, 'utf-8')
    const parsed = JSON.parse(raw) as SessionSummary
    if (typeof parsed.main !== 'string' || typeof parsed.recent !== 'string') return null
    return parsed
  } catch {
    return null
  }
}

async function writeCachedSummary(summaryPath: string, summary: SessionSummary): Promise<void> {
  try {
    await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2), 'utf-8')
  } catch {
    // Cache write failure is non-fatal — caller still gets the summary.
  }
}

/**
 * Public: get a (cached or freshly generated) summary for `sessionId`.
 * Returns null if anything fails (no provider, parse error, etc.) so the
 * caller can fall back to the zero-token hand-off path.
 *
 * `forceRefresh` ignores the cache.
 * `staleAt` (optional) — if the cached summary's `baseMessageCount` is below
 *   this number, treat it as stale and regenerate. Caller passes the live
 *   message count to detect "this session got new messages since".
 */
export async function getSessionSummary(
  sessionId: string,
  options?: { forceRefresh?: boolean; staleAt?: number },
): Promise<SessionSummary | null> {
  const found = await sessionService.findSessionFile(sessionId)
  if (!found) return null
  const summaryPath = summaryFilePathFor(found.filePath)

  if (!options?.forceRefresh) {
    const cached = await readCachedSummary(summaryPath)
    if (cached) {
      const stale =
        typeof options?.staleAt === 'number' &&
        Number.isFinite(options.staleAt) &&
        cached.baseMessageCount < options.staleAt
      if (!stale) return cached
    }
  }

  // Generate fresh.
  const target = await resolveSummarizationTarget()
  if (!target) return null

  const { text, messageCount, recentRaw } = await buildTranscriptText(found.filePath)
  if (!text || messageCount === 0) return null

  const result = await callSummarizer(target, text)
  if (!result) return null

  const parsed = tryParseSummaryResponse(result.raw)
  if (!parsed) return null

  const modelLabel =
    target.kind === 'anthropic' ? `${target.kind}:${target.model}` : `openai-codex:${target.model}`

  const summary: SessionSummary = {
    sessionId,
    generatedAt: new Date().toISOString(),
    baseMessageCount: messageCount,
    modelUsed: modelLabel,
    main: parsed.main,
    recent: parsed.recent,
    ...(recentRaw ? { recentRaw } : {}),
    ...(typeof result.tokensIn === 'number' ? { tokensIn: result.tokensIn } : {}),
    ...(typeof result.tokensOut === 'number' ? { tokensOut: result.tokensOut } : {}),
  }

  await writeCachedSummary(summaryPath, summary)
  return summary
}

/**
 * Public: cache-only read. Returns null on miss without ever invoking
 * the LLM. Intended for hot paths (e.g. the WS handoff staging handler)
 * where the caller already arranged for generation via the HTTP API and
 * doesn't want to block on an unexpected fresh LLM call. Treats missing
 * file or parse failure both as "no cached summary".
 */
export async function getCachedSessionSummary(
  sessionId: string,
): Promise<SessionSummary | null> {
  const found = await sessionService.findSessionFile(sessionId)
  if (!found) return null
  return readCachedSummary(summaryFilePathFor(found.filePath))
}

/**
 * Public: invalidate the on-disk cache for a session. Useful if the caller
 * detects the underlying transcript changed in a way that should force the
 * next read to regenerate. The next `getSessionSummary` call will lazily
 * regenerate.
 */
export async function invalidateSessionSummary(sessionId: string): Promise<void> {
  const found = await sessionService.findSessionFile(sessionId)
  if (!found) return
  const summaryPath = summaryFilePathFor(found.filePath)
  await fs.rm(summaryPath, { force: true }).catch(() => undefined)
}

/**
 * Public: render a summary as the system-prompt fragment to inject into
 * the next session via `--append-system-prompt`. Kept here so the formatting
 * stays in one place (tests assert on this exact preamble).
 */
export function formatHandoffSystemPrompt(summary: SessionSummary): string {
  const rawSection = summary.recentRaw
    ? `

## Most recent messages (verbatim, truncated)

The block below is the literal tail of the previous conversation — the LLM-generated summary above abstracted these turns, but the raw wording matters when the user said something specific (a file path, an error message, a number) that an abstraction would smudge. Each turn is truncated to ~600 chars; older turns are dropped first.

\`\`\`
${summary.recentRaw}
\`\`\`
`
    : ''
  return `# Hand-off context from the previous session

The user just continued from a previous session in this project. You did not see that conversation. Below is a two-layer summary of what the previous AI worked on so you can resume meaningfully without making the user re-explain.

When the user's next message is ambiguous or assumes prior context, treat the summary as authoritative for what was already decided / tried / built. If you need MORE detail than the summary provides, you can call the ReadPreviousSession tool (when available) with the previous session id (\`${summary.sessionId}\`) to selectively pull from the original transcript.

## Project-level summary

${summary.main}

## Most recent decisions and state

${summary.recent}${rawSection}

(Generated from session ${summary.sessionId}, ${summary.baseMessageCount} messages, model ${summary.modelUsed}, ${summary.generatedAt}.)`
}

/** Test helper: exposed paths so tests can write fixtures without re-deriving. */
export function _summaryFilePathForTest(jsonlPath: string): string {
  return summaryFilePathFor(jsonlPath)
}

/** Test helper: exposed so the trailing raw slice can be tested without
 *  spinning up an LLM. The shape contract (per-turn truncation, tail
 *  ordering, total cap) is locked in via tests; production callers go
 *  through buildTranscriptText. */
export function _buildRecentRawSliceForTest(turns: string[]): string {
  return buildRecentRawSlice(turns)
}

/** Test helper: exposed deep-mode slicing so the deep-handoff path's
 *  enlarged sizing can be locked in without spinning up an LLM. */
export function _buildRecentRawSliceDeepForTest(turns: string[]): string {
  return buildRecentRawSliceWithSizes(turns, {
    tailTurns: SUMMARY_RAW_TAIL_DEEP_TURNS,
    perTurn: SUMMARY_RAW_TAIL_DEEP_CHARS_PER_TURN,
    totalCap: SUMMARY_RAW_TAIL_DEEP_TOTAL_CHARS,
  })
}

/**
 * Public: rebuild the verbatim recentRaw slice for an existing session
 * using the hard-coded deep-mode sizing. Used by the WS handoff handler
 * when the user toggled "deep handoff" on the welcome card — we keep the
 * cached LLM-generated `main` / `recent` (no extra cost) and only
 * regenerate the verbatim tail with bigger sizes from the live JSONL.
 *
 * Returns null on missing session or empty transcript so the caller can
 * fall back to whatever recentRaw the cached summary already carries.
 */
export async function rebuildRecentRawForHandoff(
  sessionId: string,
): Promise<string | null> {
  const found = await sessionService.findSessionFile(sessionId)
  if (!found) return null
  try {
    const turns = await readTurnsFromTranscript(found.filePath)
    if (turns.length === 0) return null
    return buildRecentRawSliceWithSizes(turns, {
      tailTurns: SUMMARY_RAW_TAIL_DEEP_TURNS,
      perTurn: SUMMARY_RAW_TAIL_DEEP_CHARS_PER_TURN,
      totalCap: SUMMARY_RAW_TAIL_DEEP_TOTAL_CHARS,
    })
  } catch {
    return null
  }
}
