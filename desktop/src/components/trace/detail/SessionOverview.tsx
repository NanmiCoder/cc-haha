import { useMemo } from 'react'
import { useTranslation } from '../../../i18n'
import type { TraceSpan, TraceViewModel } from '../../../lib/traceViewModel'
import { formatDurationMs, formatTokenCount } from '../../../lib/trace/formatters'
import { StatusGlyph, TypeIcon, spanDisplayTitle } from '../TraceBadges'

type OverviewStats = {
  llmCalls: number
  toolCalls: number
  errors: number
  wallDurationMs?: number
  modelDurationMs?: number
  toolDurationMs?: number
  inputTokens: number
  outputTokens: number
  models: string[]
}

export function SessionOverview({
  span,
  viewModel,
  onSelect,
}: {
  span: TraceSpan
  viewModel: TraceViewModel
  onSelect: (spanId: string) => void
}) {
  const t = useTranslation()
  const stats = useMemo(() => computeStats(span, viewModel), [span, viewModel])
  const children = span.childIds
    .map((id) => viewModel.spansById.get(id))
    .filter((child): child is TraceSpan => !!child && child.isLifecycleNoise !== true)

  return (
    <div className="px-4 py-3" data-testid="trace-overview">
      <div className="grid grid-cols-2 gap-x-6 gap-y-3 md:grid-cols-3">
        <Stat label={t('trace.llmCalls')} value={String(stats.llmCalls)} />
        <Stat label={t('trace.toolCalls')} value={String(stats.toolCalls)} />
        <Stat label={t('trace.errors')} value={String(stats.errors)} tone={stats.errors > 0 ? 'danger' : 'default'} />
        <Stat label={t('trace.wallTime')} value={formatDurationMs(stats.wallDurationMs)} />
        <Stat label={t('trace.modelTime')} value={formatDurationMs(stats.modelDurationMs)} />
        <Stat label={t('trace.toolTime')} value={formatDurationMs(stats.toolDurationMs)} />
        <Stat
          label={t('trace.tokens')}
          value={`${formatTokenCount(stats.inputTokens)} → ${formatTokenCount(stats.outputTokens)}`}
        />
        <Stat label={t('trace.models')} value={stats.models.length > 0 ? stats.models.join(', ') : '--'} />
      </div>

      {children.length > 0 ? (
        <div className="mt-4">
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">
            {t('trace.childSpans')}
          </div>
          <div className="divide-y divide-[var(--color-border)]/60">
            {children.map((child) => (
              <button
                key={child.id}
                type="button"
                onClick={() => onSelect(child.id)}
                className="flex h-[34px] w-full items-center gap-2 text-left transition-colors hover:bg-[var(--color-surface-container-low)]"
              >
                <TypeIcon span={child} />
                <span className="min-w-0 flex-1 truncate text-xs font-semibold text-[var(--color-text-secondary)]">
                  {spanDisplayTitle(child, t)}
                </span>
                {child.durationMs !== undefined ? (
                  <span className="shrink-0 font-mono text-[10px] text-[var(--color-text-tertiary)]">
                    {formatDurationMs(child.durationMs)}
                  </span>
                ) : null}
                <StatusGlyph status={child.status} />
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  )
}

function Stat({ label, value, tone = 'default' }: { label: string; value: string; tone?: 'default' | 'danger' }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--color-text-tertiary)]">{label}</div>
      <div className={`mt-0.5 truncate font-mono text-xs ${tone === 'danger' ? 'text-[var(--color-error)]' : 'text-[var(--color-text-primary)]'}`}>
        {value}
      </div>
    </div>
  )
}

function computeStats(span: TraceSpan, viewModel: TraceViewModel): OverviewStats {
  const scoped = span.kind === 'session'
    ? viewModel.spans.filter((item) => item.id !== viewModel.rootId)
    : collectSubtree(span, viewModel)
  const stats: OverviewStats = {
    llmCalls: 0,
    toolCalls: 0,
    errors: 0,
    inputTokens: 0,
    outputTokens: 0,
    models: [],
  }
  const models = new Set<string>()
  let modelDurationMs = 0
  let toolDurationMs = 0
  for (const item of scoped) {
    if (item.kind === 'llm') {
      stats.llmCalls += 1
      if (item.call?.model) models.add(item.call.model)
      if (item.durationMs !== undefined) modelDurationMs += item.durationMs
      if (item.tokenUsage) {
        stats.inputTokens += item.tokenUsage.inputTokens
        stats.outputTokens += item.tokenUsage.outputTokens
      }
    }
    if (item.kind === 'tool') {
      stats.toolCalls += 1
      if (item.durationMs !== undefined) toolDurationMs += item.durationMs
    }
    if (item.status === 'error') stats.errors += 1
  }
  stats.models = [...models]
  if (span.durationMs !== undefined && span.durationMs > 0) stats.wallDurationMs = span.durationMs
  if (modelDurationMs > 0) stats.modelDurationMs = modelDurationMs
  if (toolDurationMs > 0) stats.toolDurationMs = toolDurationMs
  return stats
}

function collectSubtree(span: TraceSpan, viewModel: TraceViewModel): TraceSpan[] {
  const result: TraceSpan[] = []
  const visit = (id: string) => {
    const current = viewModel.spansById.get(id)
    if (!current) return
    if (current.id !== span.id) result.push(current)
    for (const childId of current.childIds) visit(childId)
  }
  visit(span.id)
  return result
}
