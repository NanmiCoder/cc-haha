import { MarkdownRenderer } from '../markdown/MarkdownRenderer'
import { useState } from 'react'

type Props = {
  content: string
  isStreaming?: boolean
}

export function AssistantMessage({ content, isStreaming }: Props) {
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(content)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      setCopied(false)
    }
  }

  return (
    <div className="group relative mb-3 ml-10">
      {/* Copy button — absolute positioned, no reserved space */}
      {!isStreaming && content.trim() && (
        <button
          onClick={handleCopy}
          className="absolute -right-1 -top-1 rounded-md border border-[var(--color-border)]/60 bg-[var(--color-surface)] px-2 py-0.5 text-[10px] text-[var(--color-text-tertiary)] opacity-0 shadow-sm transition-opacity hover:text-[var(--color-text-primary)] group-hover:opacity-100"
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      )}
      <div className="text-sm text-[var(--color-text-primary)]">
        <MarkdownRenderer content={content} />
        {isStreaming && (
          <span className="inline-block w-0.5 h-4 bg-[var(--color-brand)] animate-shimmer ml-0.5 align-text-bottom" />
        )}
      </div>
    </div>
  )
}
