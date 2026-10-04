import { useState } from 'react'
import { Wrench } from 'lucide-react'
import { useTranslation } from '../../../i18n'
import type { NormalizedBlock, NormalizedMessage } from '../../../lib/trace/types'
import { MarkdownRenderer } from '../../markdown/MarkdownRenderer'
import { Badge } from '@/components/ui/Badge'
import { CopyButton } from '@/components/ui/CopyButton'
import { CodeViewer } from '../../chat/CodeViewer'

const LONG_TEXT_CHARS = 2000

/**
 * Card per role: a 4px spine in the role's color, a tinted fill and matching
 * ink. The fills are opaque `-soft` / `-container` tokens rather than the `/8`
 * alpha modifiers they replaced — those compile to a color function Safari 15's
 * WebView drops entirely, which left the cards unfilled on iOS H5.
 *
 * Each edge is colored on its own property instead of `border-[…]` plus a
 * `border-l-[…]` override: those two write `border-color` and
 * `border-left-color`, and which wins depends on their order in the generated
 * stylesheet, not on the order they appear here.
 */
const ROLE_STYLES: Record<NormalizedMessage['role'], { badge: string; container: string }> = {
  user: {
    badge: 'text-[var(--color-text-secondary)]',
    container: 'border-y-[var(--color-border)] border-r-[var(--color-border)] border-l-[var(--color-outline)] bg-[var(--color-surface-container-low)]',
  },
  assistant: {
    badge: 'text-[var(--color-on-brand-soft)]',
    container: 'border-y-[var(--color-primary-fixed-dim)] border-r-[var(--color-primary-fixed-dim)] border-l-[var(--color-brand)] bg-[var(--color-brand-soft)]',
  },
  system: {
    badge: 'text-[var(--color-on-warning-container)]',
    container: 'border-y-[var(--color-warning)] border-r-[var(--color-warning)] border-l-[var(--color-warning)] bg-[var(--color-warning-container)]',
  },
  tool: {
    badge: 'text-[var(--color-text-tertiary)]',
    container: 'border-y-[var(--color-border)] border-r-[var(--color-border)] border-l-[var(--color-outline)] bg-[var(--color-surface-container)]',
  },
}

export function MessageBlocks({ message }: { message: NormalizedMessage }) {
  const styles = ROLE_STYLES[message.role]
  return (
    <div
      className={`trace-message-cv rounded-[var(--radius-lg)] border-y border-r border-l-4 px-4 py-3 ${styles.container}`}
      data-testid={`trace-message-${message.role}`}
    >
      <div className={`font-mono text-[11px] font-semibold uppercase tracking-[0.14em] ${styles.badge}`}>
        {message.role}
      </div>
      <div className="mt-2.5 flex flex-col gap-2.5">
        {message.content.map((block, index) => (
          <BlockView key={index} block={block} />
        ))}
      </div>
    </div>
  )
}

function BlockView({ block }: { block: NormalizedBlock }) {
  switch (block.type) {
    case 'text':
      return <TextBlock text={block.text} />
    case 'thinking':
      return <ThinkingBlock thinking={block.thinking} />
    case 'tool_use':
      return <ToolUseBlock id={block.id} name={block.name} input={block.input} />
    case 'tool_result':
      return <ToolResultBlock toolUseId={block.toolUseId} content={block.content} isError={block.isError} />
    case 'image':
      return <ImageChip mediaType={block.mediaType} />
    default:
      return null
  }
}

function TextBlock({ text }: { text: string }) {
  const t = useTranslation()
  if (!text.trim()) return null
  if (text.length < LONG_TEXT_CHARS) {
    return <MarkdownRenderer content={text} variant="compact" />
  }
  return (
    <div className="relative">
      <pre className="whitespace-pre-wrap break-words rounded-[var(--radius-md)] bg-[var(--color-surface)] px-3 py-2 font-mono text-[12px] leading-[1.7] text-[var(--color-text-secondary)]">
        {text}
      </pre>
      <CopyButton
        text={text}
        copiedLabel={t('common.copied')}
        className="absolute right-2 top-2 rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-0.5 text-[11px] text-[var(--color-text-tertiary)] transition-colors hover:text-[var(--color-text-primary)]"
      />
    </div>
  )
}

function ThinkingBlock({ thinking }: { thinking: string }) {
  const t = useTranslation()
  const [open, setOpen] = useState(false)
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="inline-flex items-center gap-1.5 rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1 text-[12px] text-[var(--color-text-secondary)] transition-colors hover:text-[var(--color-text-primary)]"
      >
        {t('trace.detail.thinking')} · {t('trace.detail.chars', { count: thinking.length })}
      </button>
      {open ? (
        <pre className="mt-2 whitespace-pre-wrap break-words text-[12.5px] italic leading-[1.7] text-[var(--color-text-tertiary)]">
          {thinking}
        </pre>
      ) : null}
    </div>
  )
}

function ToolUseBlock({ id, name, input }: { id?: string; name: string; input: unknown }) {
  return (
    <div className="min-w-0">
      <div className="flex min-w-0 items-center gap-2 text-[13px] font-bold text-[var(--color-text-primary)]">
        <Wrench size={14} strokeWidth={1.8} className="shrink-0 text-[var(--color-brand)]" />
        <span className="truncate">{name}</span>
        {id ? <span className="truncate font-mono text-[11.5px] font-normal text-[var(--color-text-tertiary)]">{id}</span> : null}
      </div>
      <div className="mt-2">
        <CodeViewer code={safeJson(input)} language="json" maxLines={24} showLineNumbers wrapLongLines unboundedHeight />
      </div>
    </div>
  )
}

function ToolResultBlock({ toolUseId, content, isError }: { toolUseId?: string; content: unknown; isError?: boolean }) {
  const t = useTranslation()
  const text = extractPlainText(content)
  return (
    <div className={`min-w-0 ${isError ? 'rounded-[var(--radius-md)] border border-[var(--color-error)] p-2' : ''}`}>
      <div className="flex min-w-0 items-center gap-2 text-[13px] font-bold text-[var(--color-text-primary)]">
        <span className={isError ? 'text-[var(--color-error)]' : ''}>
          {isError ? t('trace.toolError') : t('trace.toolResult')}
        </span>
        {toolUseId ? (
          <span className="truncate font-mono text-[11.5px] font-normal text-[var(--color-text-tertiary)]">{toolUseId}</span>
        ) : null}
      </div>
      <div className="mt-2">
        {text !== null
          ? <TextResult text={text} />
          : <CodeViewer code={safeJson(content)} language="json" maxLines={24} showLineNumbers wrapLongLines unboundedHeight />}
      </div>
    </div>
  )
}

function TextResult({ text }: { text: string }) {
  if (!text.trim()) return null
  return (
    <pre className="whitespace-pre-wrap break-words rounded-[var(--radius-md)] bg-[var(--color-surface)] px-3 py-2 font-mono text-[12px] leading-[1.7] text-[var(--color-text-secondary)]">
      {text}
    </pre>
  )
}

function ImageChip({ mediaType }: { mediaType?: string }) {
  return (
    <Badge tone="neutral" variant="outline" size="xs" pill={false} mono className="w-fit">
      [image]
      {mediaType ? <span>{mediaType}</span> : null}
    </Badge>
  )
}

function extractPlainText(content: unknown): string | null {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const item of content) {
      if (typeof item === 'string') {
        parts.push(item)
        continue
      }
      if (item && typeof item === 'object' && typeof (item as { text?: unknown }).text === 'string') {
        parts.push((item as { text: string }).text)
        continue
      }
      return null
    }
    return parts.join('\n')
  }
  return null
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? 'null'
  } catch {
    return String(value)
  }
}
