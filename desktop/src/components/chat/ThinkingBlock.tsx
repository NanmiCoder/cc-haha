import { useState, useEffect, useMemo, useRef } from 'react'
import { getDisclosure, setDisclosure } from '../../lib/disclosureMemory'
import { Brain } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { estimateTokens } from '../../lib/tpsMeter'
import { MarkdownRenderer } from '../markdown/MarkdownRenderer'
import { useSettingsStore } from '../../stores/settingsStore'

/**
 * One line: the label, a preview of the reasoning, and the full text on demand.
 *
 * There used to be a second, larger `standalone` form for a thinking block that
 * was the only thing in its run — it made sense when rows lived behind a
 * collapsed summary and a lone block needed to be findable. Now that every step
 * is a permanent row, the split only inverted the information: a turn's opening
 * reasoning is usually its most substantial, and it landed in the form that
 * showed no content at all, purely because no tool call happened to follow it in
 * the same run. Whether a thought is followed by a tool is not a fact about the
 * thought, so it no longer changes how one is drawn.
 */
export function ThinkingBlock({
  content,
  isActive = false,
  disclosureKey,
  thinkingDurationMs,
  liveStartAt,
}: {
  content: string
  isActive?: boolean
  /** Stable key that survives virtualized row unmount/remount. */
  disclosureKey?: string
  /** Wall-clock ms this block spent generating, once finished (live settle or
   * transcript replay). */
  thinkingDurationMs?: number
  /** Wall-clock epoch the block started generating (the message `timestamp`,
   * anchored to the server's first sight of the block). While the block is
   * still active the badge ticks against this, refreshed every 3s. */
  liveStartAt?: number
}) {
  const t = useTranslation()
  // 关闭会话扩展信息时隐藏本 fork 新增的思考徽标；思考正文与实时计时不受影响。
  const sessionExtendedInfo = useSettingsStore((state) => state.sessionExtendedInfo)
  const [localExpanded, setLocalExpanded] = useState(false)
  const [liveElapsedMs, setLiveElapsedMs] = useState(0)
  const expanded = disclosureKey ? (getDisclosure(disclosureKey) ?? localExpanded) : localExpanded

  // The badge's clock anchor. A live block's `timestamp` is already the
  // server's first sight of it; a history-replayed block's `timestamp` is the
  // block's *end* (the transcript line time), so back off by its recorded
  // duration to recover the true start — otherwise a replayed still-active
  // block would tick up from near zero.
  const liveAnchorMs = liveStartAt === undefined
    ? undefined
    : thinkingDurationMs !== undefined
      ? Math.max(0, liveStartAt - thinkingDurationMs)
      : liveStartAt

  // Thinking, unlike a tool, runs for a long time, so its elapsed time is shown
  // from the very first moment and refreshed on a 3s cadence while it is still
  // generating (not frozen until the block ends, which would read as "not
  // doing anything"). The clock is anchored to `liveAnchorMs` — the server's
  // first sight of the block — not the client's render time.
  useEffect(() => {
    if (!isActive || liveAnchorMs === undefined) return
    const refresh = () => {
      const elapsed = Date.now() - liveAnchorMs
      setLiveElapsedMs(Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : 0)
    }
    refresh()
    const timer = setInterval(refresh, LIVE_ELAPSED_REFRESH_MS)
    return () => clearInterval(timer)
  }, [isActive, liveAnchorMs])
  const contentRef = useRef<HTMLDivElement>(null)
  const displayContent = useMemo(() => content.replace(/\r\n?/g, '\n').trimEnd(), [content])
  const hasDisplayContent = displayContent.trim().length > 0
  const preview = useMemo(
    () => thinkingPreview(displayContent, { streaming: isActive }),
    [displayContent, isActive],
  )

  useEffect(() => {
    if (expanded && isActive && contentRef.current) {
      contentRef.current.scrollTop = contentRef.current.scrollHeight
    }
  }, [displayContent, expanded, isActive])

  const label = (
    <>
      {isActive ? t('thinking.label') : t('thinking.labelDone')}
      {isActive && <span className="thinking-dots" />}
    </>
  )

  return (
    <div>
      <style>{thinkingStyles}</style>
      <button
        type="button"
        data-chat-disclosure="true"
        data-thinking-row="true"
        onClick={() => {
          const next = !expanded
          setLocalExpanded(next)
          if (disclosureKey) setDisclosure(disclosureKey, next)
        }}
        aria-expanded={expanded}
        className="-mx-2 flex w-[calc(100%+1rem)] items-baseline gap-2 rounded-[var(--radius-md)] px-2 py-1 text-left transition-colors hover:bg-[var(--color-surface-hover)] focus:outline-none focus-visible:shadow-[var(--shadow-focus-ring)]"
      >
        <Brain
          size={13}
          strokeWidth={1.8}
          aria-hidden="true"
          className="mt-[3px] shrink-0 self-start text-[var(--color-text-tertiary)]"
        />
        <span className="shrink-0 text-[12.5px] italic text-[var(--color-text-tertiary)]">
          {label}
        </span>
        {preview ? (
          <span className="min-w-0 flex-1 truncate text-[12.5px] italic leading-[1.7] text-[var(--color-text-tertiary)]">
            {preview}
          </span>
        ) : (
          <span className="flex-1" />
        )}
        {sessionExtendedInfo !== false && thinkingBadgeLabel(content, thinkingDurationMs, liveElapsedMs, isActive, liveAnchorMs) && (
          <span
            data-thinking-usage="true"
            className="shrink-0 whitespace-nowrap font-mono text-[10px] tabular-nums text-[var(--color-text-tertiary)]"
          >
            {thinkingBadgeLabel(content, thinkingDurationMs, liveElapsedMs, isActive, liveAnchorMs)}
          </span>
        )}
        <span aria-hidden="true" className="shrink-0 text-[8px] text-[var(--color-text-tertiary)]">
          {expanded ? '▾' : '▸'}
        </span>
      </button>
      {expanded && hasDisplayContent && (
        <div
          ref={contentRef}
          data-thinking-content="expanded"
          className="relative mb-2 mt-1 max-h-[300px] overflow-y-auto rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] px-3 py-2.5 text-[11px] text-[var(--color-text-secondary)]"
        >
          <MarkdownRenderer
            content={displayContent}
            variant="compact"
            cache={!isActive}
            streaming={isActive}
            className="thinking-markdown chat-reading-markdown text-[var(--color-text-secondary)]"
          />
          {isActive && <span className="thinking-cursor" />}
        </div>
      )}
    </div>
  )
}

/** Cadence for the live thinking-elapsed refresh while a block is generating. */
export const LIVE_ELAPSED_REFRESH_MS = 3000

/**
 * Right-end badge of the thinking row: `1.23k · 12.3s` — estimated tokens of
 * the block plus how long the reader waited for it. Same "deliberately a
 * whisper" register as the activity digest: mono, tabular, tertiary.
 *
 * While the block is still generating the duration is the live elapsed time
 * (ticking, from `liveElapsedMs`); once settled it is the fixed
 * `thinkingDurationMs`. A block that is active but has no start anchor shows
 * nothing yet, so an empty first frame never prints `0.0s`. A settled block
 * without a recorded duration (pre-feature transcripts) keeps its token count
 * on its own, so the badge never disappears just because the wait time was
 * never measured.
 */
export function thinkingBadgeLabel(
  content: string,
  thinkingDurationMs: number | undefined,
  liveElapsedMs: number,
  isActive: boolean,
  liveStartAt: number | undefined,
): string {
  if (content.trim().length === 0) return ''
  if (isActive) {
    if (liveStartAt === undefined) return ''
    return `${formatThinkingTokens(content)} · ${formatThinkingDuration(liveElapsedMs)}`
  }
  // Missing or non-positive both mean "never measured": older transcripts, and
  // blocks whose start anchor was never seen (a length of exactly 0 is not a
  // real generation span). Either way the token count stands alone rather than
  // pairing with a confident `0.0s`.
  if (thinkingDurationMs === undefined || thinkingDurationMs <= 0) {
    return formatThinkingTokens(content)
  }
  return `${formatThinkingTokens(content)} · ${formatThinkingDuration(thinkingDurationMs)}`
}

/** Thinking token count as `xx.xk`, two decimals (`1.23k`, `12.50k`). */
export function formatThinkingTokens(text: string): string {
  return `${(estimateTokens(text) / 1000).toFixed(2)}k`
}

/**
 * Three-ladder duration for the thinking badge, deliberately NOT the tool
 * `formatDuration`: `<60s` → `12.3s` (one decimal), `60s~1h` → `3m05s`
 * (whole, zero-padded), `>=1h` → `2h05m` (no seconds). Round the seconds once,
 * then derive the parts — rounding each part independently can print
 * impossible values like `1m60s`.
 */
export function formatThinkingDuration(durationMs: number): string {
  const totalSeconds = Math.round(durationMs / 1000)
  if (totalSeconds < 60) return `${(durationMs / 1000).toFixed(1)}s`
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes < 60) return `${minutes}m${String(seconds).padStart(2, '0')}s`
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`
}

const THINKING_PREVIEW_MAX_CHARS = 160
/** A short line ending in a colon is a heading for what comes after it. */
const THINKING_OPENER_MAX_CHARS = 24

function cleanThinkingLines(content: string): string[] {
  const lines: string[] = []
  for (const rawLine of content.split('\n')) {
    const line = rawLine
      .trim()
      .replace(/^#{1,6}\s+/, '')
      .replace(/^[-*+]\s+/, '')
      .replace(/^>\s*/, '')
      .replace(/^\d+\.\s+/, '')
      .trim()
    if (!line || line === '---') continue
    lines.push(line)
  }
  return lines
}

/**
 * One line of reasoning for the collapsed row, stripped of the markdown that
 * would otherwise show as literal `##` / `-` noise. Always a hint — the full
 * block is one click away, so truncating here loses nothing.
 *
 * While the block is still streaming this follows the tail, because the useful
 * question then is "what is it thinking about *now*"; a first line pinned for
 * the thirty seconds a long deliberation takes answers nothing. Once it settles
 * the opening line becomes the summary again — except when that opening is a
 * bare heading like `Diagnosis complete:`, which is the one line in the block
 * that says least, so the substance under it is shown instead.
 */
export function thinkingPreview(content: string, options: { streaming?: boolean } = {}): string {
  const lines = cleanThinkingLines(content)
  if (lines.length === 0) return ''

  const picked = options.streaming
    ? lines[lines.length - 1]!
    : pickSettledPreviewLine(lines)

  return picked.length > THINKING_PREVIEW_MAX_CHARS
    ? `${picked.slice(0, THINKING_PREVIEW_MAX_CHARS)}…`
    : picked
}

function pickSettledPreviewLine(lines: string[]): string {
  const first = lines[0]!
  const isBareHeading = first.length <= THINKING_OPENER_MAX_CHARS && /[:：]$/.test(first)
  return isBareHeading ? lines[1] ?? first : first
}

const thinkingStyles = `
@keyframes thinking-cursor-blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0; }
}
@keyframes thinking-dots {
  0%, 20% { content: ''; }
  40% { content: '.'; }
  60% { content: '..'; }
  80%, 100% { content: '...'; }
}
.thinking-cursor {
  display: inline-block;
  width: 2px;
  height: 1em;
  background: var(--color-text-tertiary);
  vertical-align: middle;
  margin-left: 1px;
  animation: thinking-cursor-blink 1s step-end infinite;
}
.thinking-dots::after {
  content: '';
  animation: thinking-dots 1.4s steps(1, end) infinite;
}
.thinking-markdown > :first-child,
.thinking-markdown > :first-child > :first-child {
  margin-top: 0;
}
.thinking-markdown > :last-child,
.thinking-markdown > :last-child > :last-child {
  margin-bottom: 0;
}
`
