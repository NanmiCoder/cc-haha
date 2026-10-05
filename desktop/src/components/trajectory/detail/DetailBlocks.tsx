import type { ReactNode } from 'react'
import { useTranslation } from '../../../i18n'
import { CopyButton } from '@/components/ui/CopyButton'
import { CodeViewer } from '../../chat/CodeViewer'
import { MarkdownRenderer } from '../../markdown/MarkdownRenderer'
import { formatTraceJson } from '../../../lib/trace/formatters'

/** Past this size, syntax highlighting and markdown parsing cost more than they help. */
const RICH_RENDER_LIMIT = 120_000

const COPY_CLASS = 'inline-flex h-[22px] shrink-0 items-center gap-1 whitespace-nowrap rounded-[var(--radius-xs)] px-1.5 text-[11px] text-[var(--color-text-tertiary)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)]'

export function DetailSection({ title, actions, children }: { title: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-[12px] font-semibold text-[var(--color-text-tertiary)]">{title}</h3>
        {actions}
      </div>
      {children}
    </section>
  )
}

export function CopyAction({ text }: { text: string }) {
  const t = useTranslation()
  return <CopyButton text={text} label={t('trajectory.detail.copy')} copiedLabel={t('common.copied')} className={COPY_CLASS} />
}

/** Grows with its text; the detail panel is the one scroll container. */
export function PlainText({ text }: { text: string }) {
  return (
    <pre className="whitespace-pre-wrap break-words rounded-[var(--radius-md)] bg-[var(--color-surface-container)] px-3 py-2 font-mono text-[12px] leading-[1.65] text-[var(--color-text-secondary)]">
      {text}
    </pre>
  )
}

export function MarkdownText({ text }: { text: string }) {
  if (text.length > RICH_RENDER_LIMIT) return <PlainText text={text} />
  return <MarkdownRenderer content={text} variant="compact" cache={false} />
}

export function JsonBlock({ value, maxLines = 400 }: { value: unknown; maxLines?: number }) {
  const code = formatTraceJson(value)
  if (code.length > RICH_RENDER_LIMIT) return <PlainText text={code} />
  // The detail panel scrolls on its own; a capped inner box would leave it half empty.
  return <CodeViewer code={code} language="json" maxLines={maxLines} showLineNumbers wrapLongLines unboundedHeight />
}

export type MetaItem = { label: string; value: ReactNode }

export function MetaList({ items }: { items: readonly MetaItem[] }) {
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-5 gap-y-1.5 text-[13px]">
      {items.map((item) => (
        <div key={item.label} className="contents">
          <dt className="text-[var(--color-text-tertiary)]">{item.label}</dt>
          <dd className="min-w-0 break-words text-[var(--color-text-primary)]">{item.value}</dd>
        </div>
      ))}
    </dl>
  )
}
