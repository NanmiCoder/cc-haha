import { ExternalLink, Info } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { Badge } from '@/components/ui/Badge'
import { Card } from '@/components/ui/Card'
import type { Capability } from '../../lib/skillInsights'
import type { SecurityReport } from '../../types/market'
import { CapabilityPanel } from './CapabilityPanel'
import { safeUrl } from './marketFormat'

/** Scanner verdicts that read as a pass; everything else is worth a second look. */
const CLEAN_STATUS = /^(clean|benign|safe|pass)/i

/**
 * The security tab: what the skill will do (rule-based, from its own files),
 * then each upstream scanner's verdict with its own explanation, then — for a
 * curated skill shipped despite a flag — the curator's reason.
 *
 * Report links come from upstream, so only absolute http(s) URLs become an
 * `href`; anything else is dropped rather than rendered as a dead or hostile link.
 */
export function SecurityReportPanel({
  capabilities,
  reports,
  securityNote,
}: {
  capabilities: readonly Capability[]
  reports: readonly SecurityReport[]
  securityNote?: string
}) {
  const t = useTranslation()

  return (
    <div className="flex flex-col gap-4" data-testid="market-security-panel">
      <CapabilityPanel capabilities={capabilities} />

      {securityNote && (
        <div
          role="note"
          data-testid="market-security-note"
          className="flex items-start gap-2 rounded-[var(--radius-md)] bg-[var(--color-info-container)] px-3 py-2 text-[13px] leading-5 text-[var(--color-on-info-container)]"
        >
          <Info className="mt-[3px] flex-shrink-0" size={14} strokeWidth={1.75} aria-hidden="true" />
          <p className="min-w-0 break-words">
            <span className="font-medium">{t('market.detail.securityNote')}</span>
            {' · '}
            {securityNote}
          </p>
        </div>
      )}

      <Card radius="lg" surface="lowest" padding="none" className="overflow-hidden">
        <h2 className="flex h-10 items-center border-b border-[var(--color-border)] px-4 text-[13px] font-medium text-[var(--color-text-primary)]">{t('market.detail.scanReports')}</h2>
        {reports.length > 0 ? (
          <ul className="divide-y divide-[var(--color-border)]">
            {reports.map((report) => {
              const url = safeUrl(report.reportUrl)
              return (
                <li
                  key={`${report.vendor}:${report.status}`}
                  data-testid="market-security-report"
                  className="flex flex-col gap-1 px-4 py-3"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-mono text-xs text-[var(--color-text-primary)]">{report.vendor}</span>
                    <Badge tone={CLEAN_STATUS.test(report.status) ? 'success' : 'warning'} size="xs" wrap>
                      {report.statusText}
                    </Badge>
                  </div>
                  {report.summary && (
                    <p className="break-words text-[13px] leading-[1.6] text-[var(--color-text-secondary)]">
                      {report.summary}
                    </p>
                  )}
                  {url && (
                    <a
                      href={url}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="inline-flex w-fit items-center gap-1 rounded-[var(--radius-xs)] text-xs text-[var(--color-text-accent)] underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]"
                    >
                      {t('market.detail.viewReport')}
                      <ExternalLink size={12} strokeWidth={1.75} aria-hidden="true" />
                    </a>
                  )}
                </li>
              )
            })}
          </ul>
        ) : (
          <p className="px-4 py-3 text-[13px] text-[var(--color-text-tertiary)]">{t('market.detail.noReports')}</p>
        )}
        <p className="border-t border-[var(--color-border)] px-4 py-2.5 text-xs leading-5 text-[var(--color-text-tertiary)]">
          {t('market.detail.scanDisclaimer')}
        </p>
      </Card>
    </div>
  )
}
