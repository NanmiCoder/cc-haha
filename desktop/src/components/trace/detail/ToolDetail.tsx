import { useTranslation } from '../../../i18n'
import type { TraceSpan } from '../../../lib/traceViewModel'
import { formatTraceJson } from '../../../lib/traceViewModel'
import { formatClockTime, formatDurationMs } from '../../../lib/trace/formatters'
import { CodeViewer } from '../../chat/CodeViewer'
import { Section } from './Section'

export function ToolDetail({ span }: { span: TraceSpan }) {
  const t = useTranslation()
  const outputs = collectOutputs(span)
  const pending = span.status === 'pending'

  return (
    <div data-testid="trace-tool-detail">
      {span.input !== undefined ? (
        <Section sectionKey="tool.input" title={t('trace.section.input')} defaultOpen>
          <CodeViewer code={formatTraceJson(span.input)} language="json" maxLines={32} showLineNumbers />
        </Section>
      ) : null}

      <Section sectionKey="tool.result" title={t('trace.section.result')} defaultOpen>
        {pending ? (
          <div className="rounded-[var(--radius-md)] border border-dashed border-[var(--color-border)] px-3 py-3 text-xs text-[var(--color-text-tertiary)]">
            {t('trace.waitingForResult')}
          </div>
        ) : outputs.length > 0 ? (
          <div className="flex flex-col gap-2">
            {outputs.map((output, index) => <OutputView key={index} value={output} />)}
          </div>
        ) : (
          <div className="rounded-[var(--radius-md)] border border-dashed border-[var(--color-border)] px-3 py-3 text-xs text-[var(--color-text-tertiary)]">
            {t('trace.noData')}
          </div>
        )}
      </Section>

      <Section sectionKey="tool.meta" title={t('trace.section.meta')}>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-[11px]">
          {span.toolUseId ? (
            <MetaRow label={t('trace.detail.toolUseId')} value={span.toolUseId} />
          ) : null}
          <MetaRow
            label={t('trace.status')}
            value={span.status === 'error' ? t('trace.status.error') : span.status === 'pending' ? t('trace.status.pending') : t('trace.status.ok')}
          />
          <MetaRow label={t('trace.started')} value={formatClockTime(span.timestamp)} />
          {span.completedAt ? (
            <MetaRow label={t('trace.completed')} value={formatClockTime(span.completedAt)} />
          ) : null}
          {span.durationMs !== undefined ? (
            <MetaRow
              label={span.status === 'pending' ? t('trace.elapsed') : t('trace.duration')}
              value={formatDurationMs(span.durationMs)}
            />
          ) : null}
        </dl>
      </Section>
    </div>
  )
}

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-[var(--color-text-tertiary)]">{label}</dt>
      <dd className="min-w-0 truncate font-mono text-[var(--color-text-secondary)]">{value}</dd>
    </>
  )
}

function OutputView({ value }: { value: unknown }) {
  const text = extractPlainText(value)
  if (text !== null) {
    if (!text.trim()) return null
    return (
      <pre className="max-h-[400px] overflow-y-auto whitespace-pre-wrap break-words rounded-[var(--radius-sm)] bg-[var(--color-surface-container-low)] px-2 py-1.5 font-mono text-[11px] leading-5 text-[var(--color-text-secondary)]">
        {text}
      </pre>
    )
  }
  return <CodeViewer code={formatTraceJson(value)} language="json" maxLines={32} showLineNumbers />
}

function collectOutputs(span: TraceSpan): unknown[] {
  if (span.output === undefined) return []
  if (Array.isArray(span.output)) return span.output
  return [span.output]
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
