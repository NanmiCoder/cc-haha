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
      <style>{thinkingStyles}</style>
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
