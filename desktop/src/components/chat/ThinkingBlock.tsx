import { useState, useEffect, useMemo, useRef } from 'react'
import { getDisclosure, setDisclosure } from '../../lib/disclosureMemory'
import { ChevronRight } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { MarkdownRenderer } from '../markdown/MarkdownRenderer'
import {
  EMPTY_STREAMING_MARKDOWN_SEGMENTS,
  splitStreamingMarkdown,
  type StreamingMarkdownSegments,
} from '../../lib/streamingMarkdownSegments'

/**
 * Quiet Codex-style reasoning row: a low-contrast muted label (`Thinking` with
 * subtle horizontal shimmer while streaming → `Thought` when settled) that
 * brightens on hover, with a borderless flush scroll container (`max-h-[8.75rem]`
 * + 1rem top edge-fade) on demand.
 */
export function ThinkingBlock({
  content,
  isActive = false,
  durationLabel,
  disclosureKey,
}: {
  content: string
  isActive?: boolean
  /** Optional formatted elapsed duration shown beside the settled label. */
  durationLabel?: string
  /** Stable key that survives virtualized row unmount/remount. */
  disclosureKey?: string
}) {
  const t = useTranslation()
  const [localExpanded, setLocalExpanded] = useState(false)
  const expanded = disclosureKey ? (getDisclosure(disclosureKey) ?? localExpanded) : localExpanded
  const contentRef = useRef<HTMLDivElement>(null)
  const displayContent = useMemo(() => content.replace(/\r\n?/g, '\n').trimEnd(), [content])
  const hasDisplayContent = displayContent.trim().length > 0

  useEffect(() => {
    if (expanded && isActive && contentRef.current) {
      contentRef.current.scrollTop = contentRef.current.scrollHeight
    }
  }, [displayContent, expanded, isActive])

  const label = isActive
    ? t('thinking.label')
    : durationLabel
      ? `${t('thinking.labelDone')} · ${durationLabel}`
      : t('thinking.labelDone')

  return (
    <div>
      <button
        type="button"
        data-chat-disclosure="true"
        data-thinking-row="true"
        onClick={() => {
          if (!hasDisplayContent) return
          const next = !expanded
          setLocalExpanded(next)
          if (disclosureKey) setDisclosure(disclosureKey, next)
        }}
        aria-expanded={hasDisplayContent ? expanded : undefined}
        className="codex-work-row group/thinking inline-flex min-h-6 max-w-full items-center gap-1 rounded-[var(--radius-sm)] py-0.5 text-left text-[13px] text-[var(--color-text-tertiary)] transition-colors hover:text-[var(--color-text-primary)] focus:outline-none focus-visible:shadow-[var(--shadow-focus-ring)]"
      >
        <span className={isActive ? 'codex-shimmer-text font-medium' : 'font-normal'}>
          {label}
        </span>
        {hasDisplayContent ? (
          <ChevronRight
            size={14}
            strokeWidth={1.75}
            aria-hidden="true"
            className={`shrink-0 opacity-60 transition-transform duration-150 motion-reduce:transition-none group-hover/thinking:opacity-100 ${expanded ? 'rotate-90' : ''}`}
          />
        ) : null}
      </button>
      {expanded && hasDisplayContent && (
        <div
          ref={contentRef}
          data-thinking-content="expanded"
          className="scrollbar-autohide codex-edge-fade relative mb-1.5 mt-1 max-h-[8.75rem] overflow-y-auto py-0.5 pl-1 text-[13px] text-[var(--color-text-secondary)]"
        >
          {isActive ? (
            <StreamingThinkingMarkdown content={displayContent} />
          ) : (
            <MarkdownRenderer
              content={displayContent}
              variant="compact"
              className="thinking-markdown chat-reading-markdown text-[var(--color-text-secondary)]"
            />
          )}
        </div>
      )}
    </div>
  )
}

const STREAMING_SEGMENT_CLASS = 'thinking-markdown thinking-markdown-segment chat-reading-markdown text-[var(--color-text-secondary)]'

/**
 * The body while it streams: the settled segments are rendered once and left
 * alone, only the tail is parsed again on each delta. One renderer over the
 * whole text re-parsed all of it on every delta, and a long deliberation left
 * the renderer thread with nothing for the paste or keystroke that arrived
 * during it (#1508). Once the block settles it is rendered whole again, so the
 * finished row is the same as it always was.
 */
function StreamingThinkingMarkdown({ content }: { content: string }) {
  const previous = useRef<StreamingMarkdownSegments>(EMPTY_STREAMING_MARKDOWN_SEGMENTS)
  const segments = useMemo(() => {
    const next = splitStreamingMarkdown(content, previous.current)
    previous.current = next
    return next
  }, [content])

  return (
    <div className="thinking-markdown-live" data-thinking-segments={segments.settled.length}>
      {segments.settled.map((segment, index) => (
        <MarkdownRenderer
          key={index}
          content={segment}
          variant="compact"
          cache={false}
          streaming
          className={STREAMING_SEGMENT_CLASS}
        />
      ))}
      <MarkdownRenderer
        key="live"
        content={segments.live}
        variant="compact"
        cache={false}
        streaming
        className={STREAMING_SEGMENT_CLASS}
      />
    </div>
  )
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
