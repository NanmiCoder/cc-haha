import { CodeViewer } from './CodeViewer'
import { memo, useState } from 'react'
import { useTranslation } from '../../i18n'
import { getDisclosure, setDisclosure } from '../../lib/disclosureMemory'
import { InlineImageGallery } from './InlineImageGallery'

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

  // Don't render standalone if this result is already rendered inline
  if (!standalone) return null

  const text = extractText(content)
  const preview = text.slice(0, 200)
  const hasMore = text.length > 200

  return (
    <div className={`overflow-hidden rounded-[var(--radius-lg)] border ${
      isError
        ? 'border-[var(--color-error)]'
        : 'border-[var(--color-border)]'
    }`}>
      {/* Status header */}
      <button
        type="button"
        onClick={() => {
        const next = !expanded
        setLocalExpanded(next)
        if (disclosureKey) setDisclosure(disclosureKey, next)
      }}
        className={`flex w-full items-center justify-between px-3 py-2 text-left text-[10px] font-bold uppercase tracking-wider ${
        isError
          ? 'bg-[var(--color-error-container)] text-[var(--color-on-error-container)]'
          : 'bg-[var(--color-surface-container-high)] text-[var(--color-text-tertiary)]'
      }`}
      >
        <span className="flex items-center gap-1.5">
          <span className="material-symbols-outlined text-[12px]">
            {isError ? 'error' : 'check_circle'}
          </span>
          {toolName ? t('tool.result', { toolName }) : t('tool.resultGeneric')}
        </span>
        <span className={`px-2 py-0.5 rounded-full text-[9px] ${
          isError
            ? 'bg-[var(--color-error-container)] text-[var(--color-on-error-container)]'
            : 'bg-[var(--color-diff-added-bg)] text-[var(--color-diff-added-text)]'
        }`}>
          {isError ? t('tool.error') : t('tool.success')}
        </span>
      </button>

      {/* Inline image gallery from detected paths */}
      <InlineImageGallery text={text} />

      {/* Content */}
      {expanded ? (
        isError ? (
          <div className="bg-[var(--color-error-container)] px-3 py-2.5 font-mono text-[11px] leading-[1.5] whitespace-pre-wrap break-words text-[var(--color-on-error-container)]">
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
        <div className="bg-[var(--color-surface-container-lowest)] px-3 py-2 font-mono text-[10px] leading-[1.35] text-[var(--color-text-tertiary)]">
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
          className="w-full py-1 text-[10px] font-medium text-[var(--color-text-accent)] hover:underline bg-[var(--color-surface-container-low)] border-t border-[var(--color-border)]"
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
