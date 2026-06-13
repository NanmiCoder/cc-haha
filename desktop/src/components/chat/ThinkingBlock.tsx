import { useState, useEffect, useMemo, useRef } from 'react'
import { useTranslation } from '../../i18n'
import { MarkdownRenderer } from '../markdown/MarkdownRenderer'

export function ThinkingBlock({ content, isActive = false }: { content: string; isActive?: boolean }) {
  const t = useTranslation()
  const [expanded, setExpanded] = useState(true)
  const contentRef = useRef<HTMLDivElement>(null)
  const displayContent = useMemo(() => content.replace(/\r\n?/g, '\n').trimEnd(), [content])
  const hasDisplayContent = displayContent.trim().length > 0

  useEffect(() => {
    if (expanded && isActive && contentRef.current) {
      contentRef.current.scrollTop = contentRef.current.scrollHeight
    }
  }, [displayContent, expanded, isActive])

  return (
    <div className="mb-1">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="flex w-full items-center gap-1.5 rounded-md px-1 py-0.5 text-left text-[12px] text-[var(--color-text-tertiary)] transition-colors hover:text-[var(--color-text-secondary)]"
      >
        <span className="text-[10px] text-[var(--color-outline)]">
          {expanded ? '\u25BE' : '\u25B8'}
        </span>
        <span className="shrink-0 font-medium italic">
          {isActive ? t('thinking.label') : t('thinking.labelDone')}
          {isActive && <span className="thinking-dots" />}
        </span>
      </button>
      {expanded && hasDisplayContent && (
        <div
          ref={contentRef}
          data-thinking-content="expanded"
          className="relative mt-1 max-h-[300px] overflow-y-auto rounded-lg border border-[var(--color-border)]/40 bg-[var(--color-surface-container-lowest)] p-2.5 text-[11px] text-[var(--color-text-secondary)]"
        >
          <MarkdownRenderer
            content={displayContent}
            variant="compact"
            cache={!isActive}
            streaming={isActive}
            className="thinking-markdown text-[var(--color-text-secondary)]"
          />
          {isActive && <span className="thinking-cursor" />}
        </div>
      )}
    </div>
  )
}
