import { SettingsSection } from '@/components/settings/SettingsSection'
import { useTranslation, type Locale } from '../../i18n'
import { DATE_LOCALES } from './heatmapModel'
import { TokenAmount } from './TokenAmount'
import { seriesColor, type RankedModel } from './usageModel'

function formatCostUSD(cost: number, locale: Locale) {
  return new Intl.NumberFormat(DATE_LOCALES[locale], {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: cost >= 100 ? 0 : 2,
  }).format(cost)
}

function formatShare(part: number, whole: number, locale: Locale) {
  if (whole <= 0) return '0%'
  return new Intl.NumberFormat(DATE_LOCALES[locale], {
    maximumFractionDigits: part / whole < 0.1 ? 1 : 0,
    style: 'percent',
  }).format(part / whole)
}

const ROW = 'grid grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_72px_84px] items-center gap-5'

/** One line per ranked model: share bar, tokens and estimated cost — or a dash where no price exists. */
export function ModelDetails({ models, locale }: { models: RankedModel[]; locale: Locale }) {
  const t = useTranslation()
  if (models.length === 0) return null

  const grandTotal = models.reduce((sum, model) => sum + model.total, 0)
  const largest = models[0]?.total ?? 0
  const unpricedCount = models.filter((model) => model.unpriced).length

  return (
    <SettingsSection title={t('settings.activity.modelDetails')}>
      <div role="table" aria-label={t('settings.activity.modelUsage')}>
        <div role="row" className={`${ROW} pb-2 text-[11px] text-[var(--color-text-tertiary)]`}>
          <span role="columnheader">{t('settings.agents.model')}</span>
          <span aria-hidden="true" />
          <span role="columnheader" className="text-right">{t('settings.activity.tokens')}</span>
          <span role="columnheader" className="text-right">{t('settings.activity.estimatedCost')}</span>
        </div>
        {models.map((model) => (
          <div
            key={model.id}
            role="row"
            className={`${ROW} border-t border-[var(--color-border)] py-3.5 tabular-nums`}
          >
            <span role="cell" className="flex min-w-0 items-center gap-3" title={model.id}>
              <span
                aria-hidden="true"
                className="h-2.5 w-2.5 shrink-0 rounded-full"
                style={{ background: seriesColor(model.series) }}
              />
              <span className="min-w-0 truncate text-[15px] font-medium text-[var(--color-text-primary)]">{model.label}</span>
            </span>
            <span role="cell" className="flex items-center gap-2">
              <span aria-hidden="true" className="h-[3px] min-w-0 flex-1 bg-[var(--color-border)]">
                <span
                  className="block h-full"
                  style={{ width: `${largest > 0 ? (model.total / largest) * 100 : 0}%`, background: seriesColor(model.series) }}
                />
              </span>
              <span className="w-10 shrink-0 text-right text-[11px] text-[var(--color-text-tertiary)]">{formatShare(model.total, grandTotal, locale)}</span>
            </span>
            <span role="cell" className="text-right text-[18px] font-medium tracking-[-0.02em] text-[var(--color-text-primary)]">
              <TokenAmount amount={model.total} locale={locale} />
            </span>
            <span role="cell" className="text-right font-mono text-xs">
              {model.unpriced
                ? <span className="text-[var(--color-text-tertiary)]">—</span>
                : formatCostUSD(model.costUSD, locale)}
            </span>
          </div>
        ))}
      </div>
      {/* A partial total presented as a complete one would understate spend for anyone running
          third-party models, so say what it leaves out. */}
      {unpricedCount > 0 ? (
        <p className="mt-2 text-xs text-[var(--color-text-tertiary)]">{t('settings.activity.costExcludesModels', { count: unpricedCount })}</p>
      ) : null}
    </SettingsSection>
  )
}
