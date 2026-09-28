import { Badge } from '@/components/ui/Badge'
import { useTranslation, type TranslationKey } from '@/i18n'
import type { NetworkApplyReport, NetworkPlan, NetworkProbe, NetworkSnapshot, NetworkStepId } from '../networkTypes'
import { networkIssueKey } from './networkMessages'

const stepLabels: Record<NetworkStepId, TranslationKey> = {
  physical: 'networkManager.physical', vpn: 'networkManager.vpn', management: 'networkManager.management',
  proxy: 'networkManager.proxy', relay: 'networkManager.relay', tunnel: 'networkManager.tunnelStep', container: 'networkManager.containerStep',
}
const stateLabels = {
  ready: 'networkManager.ready', change: 'networkManager.change', manual: 'networkManager.manual',
  blocked: 'networkManager.blocked', skipped: 'networkManager.skipped',
} as const

type Props = { snapshot: NetworkSnapshot | null; plan: NetworkPlan | null; report: NetworkApplyReport | null; probes: NetworkProbe[] }

export function NetworkResults({ snapshot, plan, report, probes }: Props) {
  const t = useTranslation()
  const issueText = (issue: string) => {
    const key = networkIssueKey(issue)
    return key ? `${t(key)} (${issue})` : issue
  }
  return <div className="space-y-3" aria-live="polite">
    {snapshot && <details className="rounded-[var(--radius-lg)] border border-[var(--color-border)] p-4" open>
      <summary className="cursor-pointer text-sm font-semibold">{t('networkManager.details')} · {t('networkManager.observedAt', { time: new Date(snapshot.collectedAt).toLocaleTimeString() })}</summary>
      <div className="mt-3 space-y-2 text-xs">
        {snapshot.platform !== 'win32' && <p role="alert">{t('networkManager.unsupported')}</p>}
        {snapshot.interfaces.map(net => <p key={net.index} className="break-words">{net.alias} · {net.addresses.join(', ')} · {net.connected ? t('networkManager.ready') : t('networkManager.failed')}</p>)}
        {snapshot.selectedRoutes.map((route, index) => <p key={`${route.target}-${index}`} className="break-words font-mono">{route.target} → {route.interfaceAlias} · {t('networkManager.source')}: {route.source} · {t('networkManager.nextHop')}: {route.nextHop} ({route.prefix})</p>)}
        {snapshot.issues.map((issue, index) => <p role="alert" className="break-words text-[var(--color-error)]" key={index}>{issueText(issue)}</p>)}
      </div>
    </details>}
    {plan && <section className="space-y-3 rounded-[var(--radius-lg)] border border-[var(--color-border)] p-4" aria-label={t('networkManager.plan')}>
      {plan.steps.map((step, stepIndex) => <div key={`${step.id}-${stepIndex}`} className="space-y-1 border-b border-[var(--color-border)] pb-3 last:border-b-0">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h4 className="text-sm font-medium">{t(stepLabels[step.id])}</h4>
          <Badge tone={step.state === 'blocked' ? 'danger' : step.state === 'manual' || step.state === 'change' ? 'warning' : 'neutral'} wrap>{t(stateLabels[step.state])}</Badge>
        </div>
        <p className="text-sm">{t(`networkManager.steps.${step.code}` as TranslationKey)}</p>
        {step.details.map((detail, index) => <p className="break-words text-xs text-[var(--color-text-secondary)]" key={index}>{detail}</p>)}
      </div>)}
      {plan.changes.map(change => <div key={change.id} className="space-y-1 rounded-[var(--radius-md)] bg-[var(--color-surface-container)] p-3 text-xs">
        <p className="font-semibold">{t('networkManager.operation')}: {change.id}</p>
        <p className="break-words">{t('networkManager.before')}: {change.before}</p>
        <p className="break-words">{t('networkManager.after')}: {change.after}</p>
      </div>)}
      {!plan.changes.length && <p className="text-xs text-[var(--color-text-secondary)]">{t('networkManager.noChanges')}</p>}
    </section>}
    {report && <section className="space-y-2 rounded-[var(--radius-lg)] border border-[var(--color-border)] p-4" aria-label={t('networkManager.report')}>
      <h3 className="text-sm font-semibold">{t('networkManager.report')}</h3>
      <Badge tone={report.status === 'applied' ? 'neutral' : 'warning'} wrap>{t(report.status === 'applied' ? 'networkManager.applied' : report.status === 'rolled-back' ? 'networkManager.rolledBack' : report.status === 'rollback-conflict' ? 'networkManager.rollbackConflict' : 'networkManager.failed')}</Badge>
      {[...report.completedChanges, ...report.rollback, ...report.issues].map((text, index) => <p className="break-words text-xs" key={index}>{issueText(text)}</p>)}
    </section>}
    {probes.length > 0 && <section className="space-y-3 rounded-[var(--radius-lg)] border border-[var(--color-border)] p-4" aria-label={t('networkManager.checks')}>
      <h3 className="text-sm font-semibold">{t('networkManager.checks')}</h3>
      {probes.map((probe, index) => <div key={index} className="space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={probe.ok ? 'success' : 'danger'}>{t(probe.ok ? 'networkManager.passed' : 'networkManager.failed')}</Badge>
          <span className="break-words text-sm">{probe.target}{probe.port ? `:${probe.port}` : ''} · {probe.kind} · {probe.latencyMs} ms</span>
        </div>
        <p className="break-words text-xs">{probe.detail}</p>
        {(probe.source || probe.interfaceAlias) && <p className="text-xs text-[var(--color-text-secondary)]">{t('networkManager.source')}: {probe.source} · {probe.interfaceAlias}</p>}
        <p className="text-xs text-[var(--color-text-tertiary)]">{t('networkManager.observedAt', { time: new Date(probe.checkedAt).toLocaleTimeString() })}</p>
      </div>)}
    </section>}
  </div>
}
