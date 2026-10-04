import { useTranslation } from '../../../i18n'
import { Badge } from '@/components/ui/Badge'
import { formatClockTime, formatDurationMs } from '../../../lib/trace/formatters'
import type { ParsedResponse } from '../../../lib/trace/requestParse'
import { summarizeTraceCall } from '../../../lib/trace/requestSummary'
import type { TraceCallRecord } from '../../../types/trace'
import { CopyAction, MetaList, type MetaItem } from './DetailBlocks'

/**
 * Where the call went and with which model, at the top of the raw request:
 * the endpoint, the provider, the model id asked for, the one actually sent
 * upstream after mapping, and the one the provider says answered.
 */
export function RequestSummary({ call, response }: { call: TraceCallRecord; response: ParsedResponse | null }) {
  const t = useTranslation()
  const summary = summarizeTraceCall(call, response)
  const mono = 'font-mono text-[12px] break-all'
  const items: MetaItem[] = []

  if (summary.url) {
    items.push({
      label: t('trajectory.request.endpoint'),
      value: (
        <span className="flex items-start gap-2">
          <span className={mono} data-testid="trajectory-request-endpoint">
            {summary.method ? <span className="mr-1.5 font-semibold">{summary.method}</span> : null}
            {summary.url}
          </span>
          <CopyAction text={summary.url} />
        </span>
      ),
    })
  }
  if (summary.providerName || summary.providerFormat) {
    items.push({
      label: t('trajectory.request.provider'),
      value: (
        <span className="flex flex-wrap items-center gap-1.5">
          {summary.providerName && <span>{summary.providerName}</span>}
          {summary.providerFormat && <Badge tone="neutral" size="xs" pill={false} mono>{summary.providerFormat}</Badge>}
        </span>
      ),
    })
  }
  items.push({
    label: t('trajectory.request.route'),
    value: t(summary.route === 'proxy' ? 'trajectory.request.routeProxy' : 'trajectory.request.routeDirect'),
  })
  if (summary.requestedModel) {
    items.push({ label: t('trajectory.request.model'), value: <span className={mono} data-testid="trajectory-request-model">{summary.requestedModel}</span> })
  }
  if (summary.upstreamModel) {
    items.push({ label: t('trajectory.request.upstreamModel'), value: <span className={mono}>{summary.upstreamModel}</span> })
  }
  if (summary.respondedModel) {
    items.push({ label: t('trajectory.request.respondedModel'), value: <span className={mono}>{summary.respondedModel}</span> })
  }
  const outcome = [
    summary.status !== undefined ? `HTTP ${summary.status}` : null,
    summary.durationMs !== undefined ? formatDurationMs(summary.durationMs) : null,
    formatClockTime(summary.startedAt),
  ].filter(Boolean).join(' · ')
  items.push({
    label: t('trajectory.request.status'),
    value: (
      <span className={summary.status !== undefined && summary.status >= 400 ? 'text-[var(--color-error)]' : undefined}>{outcome}</span>
    ),
  })
  if (summary.requestId) {
    items.push({
      label: t('trajectory.request.requestId'),
      value: (
        <span className="flex items-start gap-2">
          <span className={mono}>{summary.requestId}</span>
          <CopyAction text={summary.requestId} />
        </span>
      ),
    })
  }
  if (summary.querySource) {
    items.push({ label: t('trajectory.request.purpose'), value: <span className={mono}>{summary.querySource}</span> })
  }

  return (
    <section className="mb-4 rounded-[var(--radius-md)] border border-[var(--color-border)] px-3 py-2.5" data-testid="trajectory-request-summary">
      <MetaList items={items} />
    </section>
  )
}
