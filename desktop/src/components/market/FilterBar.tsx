import { ChevronDown } from 'lucide-react'
import { forwardRef, type ButtonHTMLAttributes } from 'react'
import { useTranslation } from '../../i18n'
import { Dropdown } from '@/components/ui/Dropdown'
import { useMarketStore, type MarketFilters } from '../../stores/marketStore'
import type {
  MarketInstalledFilter,
  MarketSecurityFilter,
  MarketSourceFilter,
} from '../../types/market'

type FilterTriggerProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string
  value: string
  active: boolean
}

/**
 * `Dropdown` clones its trigger to attach a ref, the aria state and its own
 * click/keydown handlers. A trigger that neither forwards the ref nor spreads
 * the rest of its props silently drops all of that — the chips render but the
 * menu never opens.
 */
const FilterTrigger = forwardRef<HTMLButtonElement, FilterTriggerProps>(function FilterTrigger(
  { label, value, active, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      className={`inline-flex h-8 items-center gap-1.5 rounded-[var(--radius-md)] border px-2.5 text-[13px] transition-[background-color,color,border-color,box-shadow] duration-150 ease-out focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus-ring)] motion-reduce:transition-none ${
        // A narrowed filter reads as "selected", in the neutral selected fill:
        // the brand wash it used to carry is kept for brand and send only.
        active
          ? 'border-[var(--color-outline)] bg-[var(--color-surface-selected)] text-[var(--color-text-primary)]'
          : 'border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-primary)] hover:border-[var(--color-outline)] hover:bg-[var(--color-surface-hover)]'
      }`}
      {...props}
    >
      <span className="text-[var(--color-text-tertiary)]">{label}</span>
      <span className="font-medium">{value}</span>
      <ChevronDown className="text-[var(--color-text-tertiary)]" size={14} strokeWidth={1.75} aria-hidden="true" />
    </button>
  )
})

export function FilterBar({ className = '' }: { className?: string }) {
  const t = useTranslation()
  const filters = useMarketStore((s) => s.filters)
  const setFilter = useMarketStore((s) => s.setFilter)

  const sourceItems: Array<{ value: MarketSourceFilter; label: string }> = [
    { value: 'all', label: t('market.source.all') },
    { value: 'clawhub', label: t('market.source.clawhub') },
    { value: 'skillhub', label: t('market.source.skillhub') },
  ]
  const securityItems: Array<{ value: MarketSecurityFilter; label: string }> = [
    { value: 'all', label: t('market.security.all') },
    { value: 'verified', label: t('market.security.verified') },
    { value: 'benign', label: t('market.security.benign') },
    { value: 'unknown', label: t('market.security.unknown') },
    { value: 'flagged', label: t('market.security.flagged') },
  ]
  const installedItems: Array<{ value: MarketInstalledFilter; label: string }> = [
    { value: 'all', label: t('market.installedFilter.all') },
    { value: 'installed', label: t('market.installedFilter.installed') },
    { value: 'installable', label: t('market.installedFilter.installable') },
  ]

  const labelFor = <K extends keyof MarketFilters>(
    items: Array<{ value: MarketFilters[K]; label: string }>,
    value: MarketFilters[K],
  ) => items.find((i) => i.value === value)?.label ?? String(value)

  return (
    <div className={`flex flex-wrap items-center gap-2 ${className}`} data-testid="market-filter-bar">
      <Dropdown
        items={sourceItems}
        value={filters.source}
        onChange={(value) => setFilter('source', value)}
        width={220}
        trigger={
          <FilterTrigger
            label={t('market.filter.source')}
            value={labelFor(sourceItems, filters.source)}
            active={filters.source !== 'all'}
          />
        }
      />
      <Dropdown
        items={securityItems}
        value={filters.security}
        onChange={(value) => setFilter('security', value)}
        width={220}
        trigger={
          <FilterTrigger
            label={t('market.filter.security')}
            value={labelFor(securityItems, filters.security)}
            active={filters.security !== 'all'}
          />
        }
      />
      <Dropdown
        items={installedItems}
        value={filters.installed}
        onChange={(value) => setFilter('installed', value)}
        width={220}
        trigger={
          <FilterTrigger
            label={t('market.filter.installed')}
            value={labelFor(installedItems, filters.installed)}
            active={filters.installed !== 'all'}
          />
        }
      />
    </div>
  )
}
