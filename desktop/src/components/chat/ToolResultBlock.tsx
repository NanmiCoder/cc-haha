import { CodeViewer } from './CodeViewer'
import { memo, useMemo, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { getDisclosure, setDisclosure } from '../../lib/disclosureMemory'
import { extractToolResultImages } from '../../lib/toolResultContent'
import { InlineImageGallery } from './InlineImageGallery'
import { ToolResultImages } from './ToolResultImages'

type Props = {
  content: unknown
  isError: boolean
  toolName?: string
  standalone?: boolean
  /** Stable key that survives virtualized row unmount/remount. */
  disclosureKey?: string
}

/**
 * Standalone tool result block — only shown when not already rendered
 * inline within ToolCallBlock (i.e., when the tool_use and tool_result
 * are NOT grouped together by MessageList).
 */
export const ToolResultBlock = memo(function ToolResultBlock({ content, isError, toolName, standalone = true, disclosureKey }: Props) {
  const [localExpanded, setLocalExpanded] = useState(false)
  const expanded = disclosureKey ? (getDisclosure(disclosureKey) ?? localExpanded) : localExpanded
  const t = useTranslation()
  const toolImages = useMemo(() => extractToolResultImages(content), [content])

  // Don't render standalone if this result is already rendered inline
  if (!standalone) return null

  const text = extractText(content)
  const hasImages = toolImages.images.length > 0 || toolImages.dropped > 0
  const hasText = text.trim().length > 0

  return (
    <div data-tool-result-error={isError ? 'true' : undefined}>
      <button
        type="button"
        data-chat-disclosure="true"
        aria-expanded={hasText ? expanded : undefined}
        onClick={() => {
          if (!hasText) return
          const next = !expanded
          setLocalExpanded(next)
          if (disclosureKey) setDisclosure(disclosureKey, next)
        }}
        className="codex-work-row group/result inline-flex min-h-6 max-w-full items-center gap-1.5 rounded-[var(--radius-sm)] py-0.5 text-left text-[13px] text-[var(--color-text-tertiary)] transition-colors hover:text-[var(--color-text-primary)] focus:outline-none focus-visible:shadow-[var(--shadow-focus-ring)]"
      >
        <span className="min-w-0 truncate">
          {toolName ? t('tool.result', { toolName }) : t('tool.resultGeneric')}
        </span>
        {isError ? (
          <span className="shrink-0 text-[12px] text-[var(--color-text-tertiary)]">
            {t('agentStatus.failed')}
          </span>
        ) : null}
        {hasText ? (
          <ChevronRight
            size={14}
            strokeWidth={1.75}
            aria-hidden="true"
            className={`shrink-0 opacity-60 transition-transform duration-150 group-hover/result:opacity-100 ${expanded ? 'rotate-90' : ''}`}
          />
        ) : null}
      </button>

      {/* Pictures the tool returned as image blocks */}
      {hasImages ? (
        <ToolResultImages
          images={toolImages.images}
          omitted={toolImages.dropped}
          toolName={toolName}
          className="py-1.5"
        />
      ) : null}

      {/* Inline image gallery from detected paths */}
      <InlineImageGallery text={text} />

      {expanded && hasText ? (
        <div className="mt-1 overflow-hidden rounded-[var(--radius-md)] border border-[var(--color-border)]">
          {isError ? (
            <pre className="scrollbar-autohide max-h-[300px] overflow-auto whitespace-pre-wrap break-words bg-[var(--color-code-bg)] px-3 py-2 font-mono text-[12px] leading-[1.6] text-[var(--color-text-secondary)]">
              {text}
            </pre>
          ) : (
            <CodeViewer
              code={text}
              language="plaintext"
              maxLines={12}
              chrome="embedded"
            />
          )}
        </div>
      ) : null}
    </div>
  )
})

function extractText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((c: any) => (typeof c === 'string' ? c : c?.text || ''))
      .filter(Boolean)
      .join('\n')
  }
  if (content && typeof content === 'object') {
    return JSON.stringify(content, null, 2)
  }
  return String(content ?? '')
}
