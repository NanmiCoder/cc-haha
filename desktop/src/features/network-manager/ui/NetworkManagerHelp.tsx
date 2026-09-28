import { CheckCircle2, Network, Route, ShieldCheck, Waypoints } from 'lucide-react'
import { useTranslation, type TranslationKey } from '@/i18n'

const cardClass = 'rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4'
const textClass = 'text-xs leading-6 text-[var(--color-text-secondary)]'

const flow: Array<{ title: TranslationKey; body: TranslationKey }> = [
  { title: 'networkManager.physical', body: 'networkManager.help.flowPhysical' },
  { title: 'networkManager.vpn', body: 'networkManager.help.flowVpn' },
  { title: 'networkManager.proxy', body: 'networkManager.help.flowProxy' },
  { title: 'networkManager.containers', body: 'networkManager.help.flowContainers' },
  { title: 'networkManager.plan', body: 'networkManager.help.flowPlan' },
  { title: 'networkManager.verify', body: 'networkManager.help.flowVerify' },
]

const principles: TranslationKey[] = [
  'networkManager.help.principleReadOnly',
  'networkManager.help.principleRoutes',
  'networkManager.help.principleProxy',
  'networkManager.help.principleCredentials',
  'networkManager.help.principleRollback',
  'networkManager.help.principleEvidence',
]

export function NetworkManagerHelp() {
  const t = useTranslation()
  return <div className="space-y-4 text-[var(--color-text-primary)]" data-testid="network-manager-help">
    <div className="rounded-[var(--radius-lg)] border border-[var(--color-brand)] bg-[var(--color-brand-soft)] p-4">
      <div className="flex items-start gap-3">
        <Network size={20} className="mt-0.5 shrink-0 text-[var(--color-brand)]" />
        <div>
          <h3 className="text-base font-semibold">{t('networkManager.help.overviewTitle')}</h3>
          <p className="mt-1 text-sm leading-6 text-[var(--color-text-secondary)]">{t('networkManager.help.overview')}</p>
        </div>
      </div>
    </div>

    <section className={cardClass}>
      <div className="mb-3 flex items-center gap-2">
        <Waypoints size={17} className="text-[var(--color-brand)]" />
        <h3 className="text-sm font-semibold">{t('networkManager.help.modesTitle')}</h3>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <div className="rounded-[var(--radius-md)] bg-[var(--color-surface-container-low)] p-3">
          <h4 className="text-sm font-semibold">{t('networkManager.home')}</h4>
          <p className={`mt-1 ${textClass}`}>{t('networkManager.help.homeMode')}</p>
        </div>
        <div className="rounded-[var(--radius-md)] bg-[var(--color-surface-container-low)] p-3">
          <h4 className="text-sm font-semibold">{t('networkManager.work')}</h4>
          <p className={`mt-1 ${textClass}`}>{t('networkManager.help.workMode')}</p>
        </div>
      </div>
    </section>

    <section className={cardClass}>
      <div className="mb-3 flex items-center gap-2">
        <Route size={17} className="text-[var(--color-brand)]" />
        <h3 className="text-sm font-semibold">{t('networkManager.help.flowTitle')}</h3>
      </div>
      <ol className="space-y-3">
        {flow.map((step, index) => <li key={step.title} className="grid grid-cols-[28px_minmax(0,1fr)] gap-3">
          <span className="flex h-7 w-7 items-center justify-center rounded-full bg-[var(--color-surface-container)] text-xs font-semibold text-[var(--color-text-secondary)]">{index + 1}</span>
          <div>
            <h4 className="text-sm font-semibold">{t(step.title)}</h4>
            <p className={`mt-0.5 ${textClass}`}>{t(step.body)}</p>
          </div>
        </li>)}
      </ol>
    </section>

    <section className={cardClass}>
      <div className="mb-3 flex items-center gap-2">
        <ShieldCheck size={17} className="text-[var(--color-brand)]" />
        <h3 className="text-sm font-semibold">{t('networkManager.help.principlesTitle')}</h3>
      </div>
      <ul className="space-y-2">
        {principles.map(key => <li key={key} className="flex items-start gap-2">
          <CheckCircle2 size={14} className="mt-1 shrink-0 text-[var(--color-success)]" />
          <span className={textClass}>{t(key)}</span>
        </li>)}
      </ul>
    </section>

    <section className={cardClass}>
      <h3 className="text-sm font-semibold">{t('networkManager.sakura.refresh')}</h3>
      <p className={`mt-2 ${textClass}`}>{t('networkManager.sakura.autoHint')}</p>
      <p className={`mt-2 ${textClass}`}>{t('networkManager.sakura.fallbackHint')}</p>
      <p className={`mt-2 ${textClass}`}>{t('networkManager.ref.evidenceProxy')}</p>
    </section>

    <section className={cardClass}>
      <h3 className="text-sm font-semibold">{t('networkManager.ref.title')}</h3>
      <p className={`mt-2 ${textClass}`}>{t('networkManager.ref.disclaimer')}</p>
      <p className={`mt-2 ${textClass}`}>{t('networkManager.ref.planPending')}</p>
    </section>

    <section className={cardClass}>
      <h3 className="text-sm font-semibold">{t('networkManager.help.evidenceTitle')}</h3>
      <p className={`mt-2 ${textClass}`}>{t('networkManager.help.evidence')}</p>
    </section>
  </div>
}
