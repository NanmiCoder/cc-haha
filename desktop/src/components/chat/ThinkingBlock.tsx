import { useState, useEffect, useMemo, useRef } from 'react'
import { useTranslation } from '../../i18n'
import { useSettingsStore } from '../../stores/settingsStore'
import { MarkdownRenderer } from '../markdown/MarkdownRenderer'

function ThinkingBrainIcon({ isActive }: { isActive: boolean }) {
  if (isActive) {
    return (
      <svg
        className="thinking-brain-icon h-[14px] w-[14px] shrink-0 text-[var(--color-primary)]"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M12 2a6 6 0 0 0-6 6c0 1.6.6 3 1.7 4.1L12 17l4.3-4.9A6 6 0 0 0 18 8a6 6 0 0 0-6-6z" />
        <path d="M9 8a3 3 0 0 1 6 0" />
        <path d="M12 17v5" />
        <path d="M8 22h8" />
      </svg>
    )
  }
  return (
    <span className="material-symbols-outlined shrink-0 text-[14px] text-[var(--color-outline)]" aria-hidden="true">
      psychology
    </span>
  )
}

export function ThinkingBlock({ content, isActive = false }: { content: string; isActive?: boolean }) {
  const t = useTranslation()
  const thinkingAutoCollapse = useSettingsStore((s) => s.thinkingAutoCollapse)
  const [expanded, setExpanded] = useState(!thinkingAutoCollapse)
  const contentRef = useRef<HTMLDivElement>(null)
  const displayContent = useMemo(() => content.replace(/\r\n?/g, '\n').trimEnd(), [content])
  const hasDisplayContent = displayContent.trim().length > 0

  // Auto-collapse when thinking finishes (isActive transitions from true to false)
  useEffect(() => {
    if (!isActive && thinkingAutoCollapse) {
      setExpanded(false)
    }
  }, [isActive, thinkingAutoCollapse])

  // Force expand while actively thinking so user can see the stream
  useEffect(() => {
    if (isActive) {
      setExpanded(true)
    }
  }, [isActive])

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
        <ThinkingBrainIcon isActive={isActive} />
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
