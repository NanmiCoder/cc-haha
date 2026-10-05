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
 * One block per role, told apart by ground rather than colour: what was sent
 * in (user / tool results) is sunken, the model's reply is a hairline frame,
 * and the harness-authored system message takes the heavier outline. Status
 * colours stay out of it — amber means "needs you" and terracotta is the brand,
 * neither of which a message role is. Each block is either filled or framed,
 * never both, so nothing reads as a card inside a card.
 */
const ROLE_STYLES: Record<NormalizedMessage['role'], { badge: string; container: string }> = {
  user: {
    badge: 'text-[var(--color-text-secondary)]',
    container: 'bg-[var(--color-surface-container)]',
  },
  assistant: {
    badge: 'text-[var(--color-text-primary)]',
    container: 'border border-[var(--color-border)]',
  },
  system: {
    badge: 'text-[var(--color-text-tertiary)]',
    container: 'border border-[var(--color-outline)]',
  },
  tool: {
    badge: 'text-[var(--color-text-tertiary)]',
    container: 'bg-[var(--color-surface-container)]',
  },
}

export function MessageBlocks({ message }: { message: NormalizedMessage }) {
  const styles = ROLE_STYLES[message.role]
  return (
    <div
      className={`trace-message-cv rounded-[var(--radius-md)] px-3.5 py-3 ${styles.container}`}
      data-testid={`trace-message-${message.role}`}
    >
      <div className={`font-mono text-[11px] font-medium ${styles.badge}`}>
        {message.role}
      </div>
      <div className="mt-2 flex flex-col gap-2.5">
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
      <pre className="whitespace-pre-wrap break-words rounded-[var(--radius-md)] bg-[var(--color-code-bg)] px-3 py-2 font-mono text-[12px] leading-[1.7] text-[var(--color-text-secondary)]">
        {text}
      </pre>
      <CopyButton
        text={text}
        copiedLabel={t('common.copied')}
        className="absolute right-2 top-2 inline-flex h-[22px] items-center gap-1 rounded-[var(--radius-xs)] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] px-1.5 text-[11px] text-[var(--color-text-tertiary)] transition-colors hover:text-[var(--color-text-primary)]"
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
        className="inline-flex h-7 items-center gap-1.5 rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] px-2.5 text-[12px] text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)]"
      >
        {t('trace.detail.thinking')} · {t('trace.detail.chars', { count: thinking.length })}
      </button>
      {open ? (
        <pre className="ml-[7px] mt-2 whitespace-pre-wrap break-words border-l border-[var(--color-outline)] pl-3.5 text-[13px] leading-[1.7] text-[var(--color-text-secondary)]">
          {thinking}
        </pre>
      ) : null}
    </div>
  )
}

function ToolUseBlock({ id, name, input }: { id?: string; name: string; input: unknown }) {
  return (
    <div className="min-w-0">
      <div className="flex min-w-0 items-center gap-2 text-[13px] font-medium text-[var(--color-text-primary)]">
        <Wrench size={14} strokeWidth={1.75} className="shrink-0 text-[var(--color-text-tertiary)]" />
        <span className="truncate">{name}</span>
        {id ? <span className="truncate font-mono text-[11px] font-normal text-[var(--color-text-tertiary)]">{id}</span> : null}
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
      <div className="flex min-w-0 items-center gap-2 text-[13px] font-medium text-[var(--color-text-primary)]">
        <span className={isError ? 'text-[var(--color-error)]' : ''}>
          {isError ? t('trace.toolError') : t('trace.toolResult')}
        </span>
        {toolUseId ? (
          <span className="truncate font-mono text-[11px] font-normal text-[var(--color-text-tertiary)]">{toolUseId}</span>
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
    <pre className="whitespace-pre-wrap break-words rounded-[var(--radius-md)] bg-[var(--color-code-bg)] px-3 py-2 font-mono text-[12px] leading-[1.7] text-[var(--color-text-secondary)]">
      {text}
    </pre>
  )
}

function ImageChip({ mediaType }: { mediaType?: string }) {
  const t = useTranslation()
  return (
    <Badge tone="neutral" variant="outline" size="xs" pill={false} mono className="w-fit">
      {t('trace.detail.imageBlock')}
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
