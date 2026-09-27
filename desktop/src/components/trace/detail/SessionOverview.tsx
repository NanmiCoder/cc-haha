import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from '../../../i18n'
import type { TraceSpan, TraceViewModel } from '../../../lib/traceViewModel'
import { formatDurationMs, formatTokenCount } from '../../../lib/trace/formatters'
import { fetchTraceCallDetail } from '../../../lib/trace/callCache'
import { parseTraceRequestBody } from '../../../lib/trace/requestParse'
import { StatusGlyph, TypeIcon, spanDisplayTitle } from '../TraceBadges'
import { Section } from './Section'

/**
 * The model-visible request header as the session opened, read from the first
 * model call so it does not have to be hunted down inside an individual one.
 * Only that call is fetched, because session-level snapshots truncate request
 * bodies.
 *
 * It is the opening header, not a session-wide invariant: late tool
 * registration and a mid-session model change both rewrite the system prompt
 * and tool catalog for later requests. A specific request's own header stays on
 * that request's detail.
 */
function SessionRequestHeader({
  viewModel,
  sessionId,
  revisionKey,
}: {
  viewModel: TraceViewModel
  sessionId?: string
  revisionKey?: string
}) {
  const t = useTranslation()
  const [header, setHeader] = useState<{
    system?: string
    tools: Array<{ name: string; description?: string }>
  } | null>(null)

  const firstCallId = useMemo(() => {
    for (const candidate of viewModel.spans) {
      if (candidate.kind === 'llm' && candidate.call?.id) return candidate.call.id
    }
    return null
  }, [viewModel])

  useEffect(() => {
    if (!sessionId || !firstCallId) {
      // Without this, switching to a session that has no call keeps showing the
      // previous session's system prompt.
      setHeader(null)
      return
    }
    let cancelled = false
    void fetchTraceCallDetail(sessionId, firstCallId, revisionKey).then((call) => {
      if (cancelled) return
      if (!call) return
      const semantic = call.request.semantic
      const requestBody = semantic ? JSON.stringify(semantic.request) : call.request.body.preview
      const parsed = requestBody
        ? parseTraceRequestBody(requestBody, semantic ? 'anthropic' : call.source)
        : null
      if (!parsed) return
      setHeader({
        ...(parsed.system !== undefined ? { system: parsed.system } : {}),
        tools: parsed.tools.map((tool) => ({
          name: tool.name,
          ...(tool.description ? { description: tool.description } : {}),
        })),
      })
    })
    return () => { cancelled = true }
  }, [sessionId, firstCallId, revisionKey])

  if (!header) return null
  const hasSystem = Boolean(header.system)
  if (!hasSystem && header.tools.length === 0) return null

  return (
    <div className="mt-5 flex flex-col gap-1">
      {header.system ? (
        <Section
          sectionKey="overview.systemPrompt"
          title={t('trace.section.systemPrompt')}
          badge={t('trace.detail.chars', { count: header.system.length })}
        >
          <pre className="max-h-[360px] overflow-y-auto whitespace-pre-wrap break-words text-[12.5px] leading-[1.7] text-[var(--color-text-secondary)]">
            {header.system}
          </pre>
        </Section>
      ) : null}
      {header.tools.length > 0 ? (
        <Section sectionKey="overview.tools" title={t('trace.section.tools')} badge={header.tools.length}>
          <div className="flex flex-col gap-1">
            {header.tools.map((tool) => (
              <div key={tool.name} className="flex min-w-0 items-baseline gap-2">
                <span className="shrink-0 font-mono text-[12px] text-[var(--color-text-primary)]">{tool.name}</span>
                {tool.description ? (
                  <span className="min-w-0 truncate text-[12px] text-[var(--color-text-tertiary)]">
                    {tool.description}
                  </span>
                ) : null}
              </div>
            ))}
          </div>
        </Section>
      ) : null}
    </div>
  )
}

type OverviewStats = {
  llmCalls: number
  toolCalls: number
  errors: number
  wallDurationMs?: number
  modelDurationMs?: number
  toolDurationMs?: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  models: string[]
}

export function SessionOverview({
  span,
  viewModel,
  onSelect,
  sessionId,
  revisionKey,
}: {
  span: TraceSpan
  viewModel: TraceViewModel
  onSelect: (spanId: string) => void
  sessionId?: string
  revisionKey?: string
}) {
  const t = useTranslation()
  const stats = useMemo(() => computeStats(span, viewModel), [span, viewModel])
  const children = span.childIds
    .map((id) => viewModel.spansById.get(id))
    .filter((child): child is TraceSpan => !!child && child.isLifecycleNoise !== true)

  return (
    <div className="px-6 py-5" data-testid="trace-overview">
      <div className="grid grid-cols-2 gap-x-6 gap-y-4 md:grid-cols-3">
        <Stat label={t('trace.llmCalls')} value={String(stats.llmCalls)} />
        <Stat label={t('trace.toolCalls')} value={String(stats.toolCalls)} />
        <Stat label={t('trace.errors')} value={String(stats.errors)} tone={stats.errors > 0 ? 'danger' : 'default'} />
        <Stat label={t('trace.wallTime')} value={formatDurationMs(stats.wallDurationMs)} />
        <Stat label={t('trace.modelTime')} value={formatDurationMs(stats.modelDurationMs)} />
        <Stat label={t('trace.toolTime')} value={formatDurationMs(stats.toolDurationMs)} />
        <Stat
          label={t('trace.inputOutputTokens')}
          value={`${formatTokenCount(stats.inputTokens)} → ${formatTokenCount(stats.outputTokens)}`}
        />
        {stats.cacheReadTokens > 0 || stats.cacheCreationTokens > 0 ? (
          <Stat
            label={t('trace.cacheTokens')}
            value={`${formatTokenCount(stats.cacheReadTokens)} → ${formatTokenCount(stats.cacheCreationTokens)}`}
          />
        ) : null}
        <Stat label={t('trace.models')} value={stats.models.length > 0 ? stats.models.join(', ') : '--'} />
      </div>

      <SessionRequestHeader viewModel={viewModel} sessionId={sessionId} revisionKey={revisionKey} />

      {children.length > 0 ? (
        <div className="mt-6">
          <div className="mb-1.5 font-mono text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">
            {t('trace.childSpans')}
          </div>
          <div className="divide-y divide-[var(--color-border)]">
            {children.map((child) => (
              <button
                key={child.id}
                type="button"
                onClick={() => onSelect(child.id)}
                className="flex h-[34px] w-full items-center gap-2 text-left transition-colors hover:bg-[var(--color-surface-hover)]"
              >
                <TypeIcon span={child} />
                <span className="min-w-0 flex-1 truncate text-[13.5px] font-semibold text-[var(--color-text-secondary)]">
                  {spanDisplayTitle(child, t)}
                </span>
                {child.durationMs !== undefined ? (
                  <span className="shrink-0 font-mono text-[12px] text-[var(--color-text-tertiary)]">
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
      <div className="text-[11px] font-medium uppercase tracking-[0.1em] text-[var(--color-text-tertiary)]">{label}</div>
      <div className={`mt-1 truncate font-mono text-[15px] font-semibold ${tone === 'danger' ? 'text-[var(--color-error)]' : 'text-[var(--color-text-primary)]'}`}>
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
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
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
        stats.cacheReadTokens += item.tokenUsage.cacheReadInputTokens ?? 0
        stats.cacheCreationTokens += item.tokenUsage.cacheCreationInputTokens ?? 0
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
