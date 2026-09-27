import { useTranslation } from '../../i18n'
import type { TraceSpan, TraceViewModel } from '../../lib/traceViewModel'
import { formatTraceJson } from '../../lib/traceViewModel'
import { formatClockTime, formatDurationMs, formatTokenCount, formatUsageBrief } from '../../lib/trace/formatters'
import { formatBytes } from '../../lib/formatBytes'
import { CodeViewer } from '../chat/CodeViewer'
import { MetaChip, StatusPill, TypeIcon, spanDisplayTitle, traceEventPhaseLabel } from './TraceBadges'
import { Section } from './detail/Section'
import { LlmCallDetail } from './detail/LlmCallDetail'
import { ToolDetail } from './detail/ToolDetail'
import { MessageDetail } from './detail/MessageDetail'
import { SessionOverview } from './detail/SessionOverview'

export function TraceDetail({
  span,
  viewModel,
  sessionId,
  revisionKey,
  overviewRevisionKey,
  onSelect,
}: {
  span: TraceSpan
  viewModel: TraceViewModel
  sessionId: string
  revisionKey?: string
  overviewRevisionKey?: string
  onSelect: (spanId: string) => void
}) {
  const t = useTranslation()
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="trace-detail">
      <div className="shrink-0 border-b border-[var(--color-border)] px-6 py-4">
        <div className="flex min-w-0 items-center gap-2.5">
          <TypeIcon span={span} size={16} />
          <h2
            className="min-w-0 truncate text-[17px] font-bold text-[var(--color-text-primary)]"
            style={{ fontFamily: 'var(--font-headline)' }}
          >
            {spanDisplayTitle(span, t)}
          </h2>
          <StatusPill status={span.status} />
        </div>
        <div className="mt-2.5 flex min-w-0 flex-wrap items-baseline gap-x-4 gap-y-1.5">
          <HeaderChips span={span} />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* Left-aligned reading column, per the handoff's 960px detail width —
            long JSON bodies are unreadable stretched across a wide monitor. */}
        <div className="w-full max-w-[960px]">
          <DetailBody
            span={span}
            viewModel={viewModel}
            sessionId={sessionId}
            revisionKey={revisionKey}
            overviewRevisionKey={overviewRevisionKey}
            onSelect={onSelect}
          />
        </div>
      </div>
    </div>
  )
}

function DetailBody({
  span,
  viewModel,
  sessionId,
  revisionKey,
  overviewRevisionKey,
  onSelect,
}: {
  span: TraceSpan
  viewModel: TraceViewModel
  sessionId: string
  revisionKey?: string
  overviewRevisionKey?: string
  onSelect: (spanId: string) => void
}) {
  switch (span.kind) {
    case 'llm':
      return <LlmCallDetail sessionId={sessionId} span={span} revisionKey={revisionKey} />
    case 'tool':
    case 'tool_result':
      return <ToolDetail span={span} />
    case 'message':
      return <MessageDetail span={span} />
    case 'event':
      return <EventDetail span={span} />
    default:
      return (
        <SessionOverview
          span={span}
          viewModel={viewModel}
          onSelect={onSelect}
          sessionId={sessionId}
          revisionKey={overviewRevisionKey ?? revisionKey}
        />
      )
  }
}

function HeaderChips({ span }: { span: TraceSpan }) {
  const t = useTranslation()
  const call = span.call
  if (call) {
    return (
      <>
        {call.model ? <MetaChip label={t('trace.model')} value={call.model} /> : null}
        {call.provider?.name ? <MetaChip label={t('trace.provider')} value={call.provider.name} /> : null}
        {span.durationMs !== undefined ? (
          <MetaChip
            label={span.status === 'pending' ? t('trace.elapsed') : t('trace.duration')}
            value={formatDurationMs(span.durationMs)}
          />
        ) : null}
        {call.usage ? (
          <MetaChip
            label={t('trace.tokens')}
            value={formatUsageBrief(call.usage)}
            title={usageTooltip(call.usage)}
          />
        ) : null}
        <MetaChip label={t('trace.request')} value={formatBytes(call.request.body.bytes)} />
        {call.response ? (
          <>
            <MetaChip label={t('trace.response')} value={formatBytes(call.response.body.bytes)} />
            <MetaChip
              label={t('trace.status')}
              value={String(call.response.status)}
              tone={call.response.status >= 400 ? 'danger' : 'default'}
            />
          </>
        ) : null}
        <MetaChip label={t('trace.started')} value={formatClockTime(call.startedAt)} />
        {span.completedAt ? <MetaChip label={t('trace.completed')} value={formatClockTime(span.completedAt)} /> : null}
      </>
    )
  }
  return (
    <>
      {span.toolUseId ? <MetaChip label={t('trace.detail.toolUseId')} value={span.toolUseId} /> : null}
      {span.durationMs !== undefined ? (
        <MetaChip
          label={durationLabelForSpan(span, t)}
          value={formatDurationMs(span.durationMs)}
        />
      ) : null}
      <MetaChip label={t('trace.started')} value={formatClockTime(span.timestamp)} />
      {span.completedAt ? <MetaChip label={t('trace.completed')} value={formatClockTime(span.completedAt)} /> : null}
    </>
  )
}

function durationLabelForSpan(span: TraceSpan, t: ReturnType<typeof useTranslation>): string {
  if (span.status === 'pending') return t('trace.elapsed')
  if (span.kind === 'session' || span.kind === 'turn') return t('trace.wallTime')
  return t('trace.duration')
}

function usageTooltip(usage: NonNullable<TraceSpan['tokenUsage']>): string {
  const parts = [
    `in ${formatTokenCount(usage.inputTokens)}`,
    `out ${formatTokenCount(usage.outputTokens)}`,
  ]
  if (usage.cacheReadInputTokens !== undefined) {
    parts.push(`cache read ${formatTokenCount(usage.cacheReadInputTokens)}`)
  }
  if (usage.cacheCreationInputTokens !== undefined) {
    parts.push(`cache write ${formatTokenCount(usage.cacheCreationInputTokens)}`)
  }
  return parts.join(' · ')
}

function EventDetail({ span }: { span: TraceSpan }) {
  const t = useTranslation()
  const event = span.event
  if (!event) return null
  return (
    <div data-testid="trace-event-detail">
      <Section sectionKey="event.detail" title={t('trace.section.event')} defaultOpen>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-[12.5px]">
          <dt className="text-[var(--color-text-tertiary)]">{t('trace.detail.phase')}</dt>
          <dd className="min-w-0 truncate font-mono text-[var(--color-text-secondary)]">
            {traceEventPhaseLabel(event.phase, t)}
          </dd>
          <dt className="text-[var(--color-text-tertiary)]">{t('trace.detail.severity')}</dt>
          <dd className={`min-w-0 truncate font-mono ${event.severity === 'error' ? 'text-[var(--color-error)]' : 'text-[var(--color-text-secondary)]'}`}>
            {event.severity}
          </dd>
          {event.message ? (
            <>
              <dt className="text-[var(--color-text-tertiary)]">{t('trace.detail.message')}</dt>
              <dd className="min-w-0 whitespace-pre-wrap break-words text-[var(--color-text-secondary)]">
                {event.message}
              </dd>
            </>
          ) : null}
        </dl>
      </Section>
      {event.metadata && Object.keys(event.metadata).length > 0 ? (
        <Section sectionKey="event.metadata" title={t('trace.section.metadata')} defaultOpen>
          <CodeViewer code={formatTraceJson(event.metadata)} language="json" maxLines={32} showLineNumbers />
        </Section>
      ) : null}
    </div>
  )
}
