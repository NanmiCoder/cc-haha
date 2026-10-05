import { CodeViewer } from './CodeViewer'
import { memo, useMemo, useState } from 'react'
import { CircleAlert, CircleCheck } from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
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
  const preview = text.slice(0, 200)
  const hasMore = text.length > 200
  const hasImages = toolImages.images.length > 0 || toolImages.dropped > 0

  return (
    <div className="overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)]">
      {/* Status header */}
      <button
        type="button"
        onClick={() => {
        const next = !expanded
        setLocalExpanded(next)
        if (disclosureKey) setDisclosure(disclosureKey, next)
      }}
        className="flex min-h-9 w-full items-center gap-2 px-3 text-left text-[13px] transition-colors hover:bg-[var(--color-surface-hover)] focus:outline-none focus-visible:shadow-[var(--shadow-focus-ring)]"
      >
        {isError ? (
          <CircleAlert size={14} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-[var(--color-error)]" />
        ) : (
          <CircleCheck size={14} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-[var(--color-text-tertiary)]" />
        )}
        <span className="min-w-0 flex-1 truncate font-medium text-[var(--color-text-primary)]">
          {toolName ? t('tool.result', { toolName }) : t('tool.resultGeneric')}
        </span>
        <Badge tone={isError ? 'danger' : 'success'}>
          {isError ? t('tool.error') : t('tool.success')}
        </Badge>
      </button>

      {/* Pictures the tool returned as image blocks */}
      {hasImages ? (
        <ToolResultImages
          images={toolImages.images}
          omitted={toolImages.dropped}
          toolName={toolName}
          className="px-3 py-2"
        />
      ) : null}

      {/* Inline image gallery from detected paths */}
      <InlineImageGallery text={text} />

      {/* Content. A result that is only pictures has no text to preview. */}
      {!text && hasImages ? null : expanded ? (
        isError ? (
          <div className="whitespace-pre-wrap break-words border-t border-[var(--color-border)] bg-[var(--color-error-container)] px-3 py-2.5 font-mono text-[12px] leading-[1.6] text-[var(--color-on-error-container)]">
            {text}
          </div>
        ) : (
          <CodeViewer
            code={text}
            language="plaintext"
            maxLines={12}
          />
        )
      ) : (
        <div className="border-t border-[var(--color-border)] bg-[var(--color-surface-container)] px-3 py-2 font-mono text-[12px] leading-[1.5] text-[var(--color-text-tertiary)]">
          {preview}
          {hasMore ? '…' : ''}
        </div>
      )}

      {hasMore && (
        <button
          onClick={() => {
            const next = !expanded
            setLocalExpanded(next)
            if (disclosureKey) setDisclosure(disclosureKey, next)
          }}
          type="button"
          className="flex h-7 w-full items-center justify-center border-t border-[var(--color-border)] text-[12px] text-[var(--color-text-tertiary)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)] focus:outline-none focus-visible:shadow-[var(--shadow-focus-ring)]"
        >
          {expanded ? t('tool.showLess') : t('tool.showMore', { count: text.length - 200 })}
        </button>
      )}
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
