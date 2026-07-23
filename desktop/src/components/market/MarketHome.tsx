import { useEffect } from 'react'
import { CloudOff, PackageSearch, RefreshCw, Search, Store, X } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { useMarketStore } from '../../stores/marketStore'
import { FilterBar } from './FilterBar'
import { MarketDisclaimer } from './MarketDisclaimer'
import { SkillCard } from './SkillCard'
import { SourceStatusBar } from './SourceStatusBar'
import { InstalledSkillsOverview } from './InstalledSkillsOverview'

export function MarketHome({ onRequestInstall }: { onRequestInstall: (id: string) => void }) {
  const t = useTranslation()
  const {
    items,
    nextCursor,
    sources,
    query,
    filters,
    isLoading,
    isLoadingMore,
    error,
    fetchList,
    loadMore,
    setQuery,
    installingIds,
  } = useMarketStore()

  useEffect(() => {
    if (items.length === 0 && !isLoading && !error) {
      void fetchList({ reset: true })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const hasActiveFilters =
    filters.source !== 'all' || filters.security !== 'all' || filters.installed !== 'all'
  const hasQuery = query.trim().length > 0

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-[var(--color-surface-container-lowest)]">
      <header className="shrink-0 border-b border-[var(--color-border)]/70 bg-[var(--color-surface)]">
        <div className="mx-auto flex w-full max-w-[1400px] flex-wrap items-center justify-between gap-5 px-6 py-6 lg:px-8">
          <div className="flex min-w-0 items-center gap-3.5">
            <span className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-container-low)] text-[var(--color-brand)] shadow-[0_1px_2px_rgba(27,28,26,0.06)]">
              <Store className="h-5 w-5" strokeWidth={1.9} aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <h1 className="text-[22px] font-semibold leading-7 tracking-[-0.025em] text-[var(--color-text-primary)]">
                {t('market.title')}
              </h1>
              <p className="mt-0.5 max-w-2xl text-[13px] leading-5 text-[var(--color-text-secondary)]">
                {t('market.subtitle')}
              </p>
            </div>
          </div>
          <SourceStatusBar sources={sources} />
        </div>
      </header>

      <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-4 px-6 py-5 lg:px-8">
        <InstalledSkillsOverview />

        <MarketDisclaimer />

        <section className="sticky top-0 z-20 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-glass)] p-2.5 shadow-[0_8px_24px_rgba(27,28,26,0.06)] backdrop-blur-xl">
          <div className="flex flex-wrap items-center gap-2.5">
            <div className="flex min-h-10 min-w-[260px] flex-1 items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] px-3 transition-colors focus-within:border-[var(--color-border-focus)] focus-within:shadow-[var(--shadow-focus-ring)]">
              <Search className="h-4 w-4 flex-shrink-0 text-[var(--color-text-tertiary)]" strokeWidth={2} aria-hidden="true" />
              <input
                data-testid="market-search-input"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t('market.searchPlaceholder')}
                aria-label={t('market.searchPlaceholder')}
                className="min-w-0 flex-1 bg-transparent text-[13px] text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-tertiary)]"
              />
              {query && (
                <button
                  type="button"
                  aria-label={t('market.clearSearch')}
                  onClick={() => setQuery('')}
                  className="inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--color-text-tertiary)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus-ring)]"
                >
                  <X className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
                </button>
              )}
            </div>
            <FilterBar />
          </div>
        </section>

        {!isLoading && items.length > 0 && (
          <div className="flex items-center gap-3 px-0.5">
            <p className="flex-shrink-0 text-[11px] font-medium tabular-nums text-[var(--color-text-tertiary)]">
              {t('market.resultCount', { count: String(items.length) })}
            </p>
            <div className="h-px flex-1 bg-[var(--color-border)]/60" />
          </div>
        )}

        {isLoading && <MarketGridSkeleton label={t('market.loading')} />}

        {!isLoading && error && (
          <div
            data-testid="market-error"
            className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-[var(--color-error)]/35 bg-[var(--color-error-container)]/25 px-6 py-14 text-center"
          >
            <CloudOff className="h-8 w-8 text-[var(--color-error)]" strokeWidth={1.7} aria-hidden="true" />
            <p className="text-sm font-medium text-[var(--color-text-primary)]">{t('market.error.list')}</p>
            <p className="max-w-md break-words text-xs text-[var(--color-text-tertiary)]">{error}</p>
            <button
              type="button"
              onClick={() => void fetchList({ reset: true })}
              className="mt-1 inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-4 text-sm text-[var(--color-text-primary)] transition-colors hover:border-[var(--color-border-focus)] hover:bg-[var(--color-surface-hover)] focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus-ring)] active:scale-[0.98]"
            >
              <RefreshCw className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
              {t('market.retry')}
            </button>
          </div>
        )}

        {!isLoading && !error && items.length === 0 && (
          <div
            data-testid="market-empty"
            className="rounded-xl border border-dashed border-[var(--color-border)] bg-[var(--color-surface-container-low)] px-6 py-16 text-center"
          >
            {hasQuery || hasActiveFilters ? (
              <PackageSearch className="mx-auto mb-3 h-9 w-9 text-[var(--color-text-tertiary)]" strokeWidth={1.6} aria-hidden="true" />
            ) : (
              <Store className="mx-auto mb-3 h-9 w-9 text-[var(--color-text-tertiary)]" strokeWidth={1.6} aria-hidden="true" />
            )}
            <p className="text-sm text-[var(--color-text-tertiary)]">
              {hasQuery || hasActiveFilters ? t('market.emptySearch') : t('market.empty')}
            </p>
            <p className="mt-1 text-xs text-[var(--color-text-tertiary)]">
              {hasQuery || hasActiveFilters ? t('market.emptySearchHint') : t('market.emptyHint')}
            </p>
          </div>
        )}

        {!isLoading && items.length > 0 && (
          <>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3" data-testid="market-grid">
              {items.map((skill) => (
                <SkillCard
                  key={skill.id}
                  skill={skill}
                  onOpen={(id) => void useMarketStore.getState().openDetail(id)}
                  onInstall={onRequestInstall}
                  installing={installingIds.has(skill.id)}
                />
              ))}
            </div>

            {nextCursor && (
              <div className="flex justify-center py-2 pb-5">
                <button
                  type="button"
                  data-testid="market-load-more"
                  disabled={isLoadingMore}
                  onClick={() => void loadMore()}
                  className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-5 text-sm text-[var(--color-text-primary)] transition-colors hover:border-[var(--color-border-focus)] hover:bg-[var(--color-surface-hover)] focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus-ring)] active:scale-[0.98] disabled:opacity-60"
                >
                  {isLoadingMore && (
                    <span className="h-3.5 w-3.5 animate-spin rounded-full border border-current border-t-transparent" aria-hidden />
                  )}
                  {isLoadingMore ? t('market.loadingMore') : t('market.loadMore')}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

function MarketGridSkeleton({ label }: { label: string }) {
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3" data-testid="market-loading" aria-label={label}>
      {Array.from({ length: 6 }, (_, index) => (
        <div
          key={index}
          className="min-h-[212px] animate-pulse rounded-xl border border-[var(--color-border)]/60 bg-[var(--color-surface-container-low)] p-4"
        >
          <div className="flex items-start gap-3.5">
            <div className="h-[46px] w-[46px] rounded-[14px] bg-[var(--color-surface-container-high)]" />
            <div className="min-w-0 flex-1 pt-0.5">
              <div className="h-3.5 w-2/3 rounded bg-[var(--color-surface-container-high)]" />
              <div className="mt-2 h-2.5 w-1/3 rounded bg-[var(--color-surface-container)]" />
            </div>
          </div>
          <div className="mt-4 h-2.5 w-full rounded bg-[var(--color-surface-container-high)]" />
          <div className="mt-2 h-2.5 w-4/5 rounded bg-[var(--color-surface-container)]" />
          <div className="mt-4 h-2.5 w-1/2 rounded bg-[var(--color-surface-container)]" />
          <div className="mt-5 h-px bg-[var(--color-border)]/50" />
          <div className="mt-3 flex items-center justify-between">
            <div className="h-6 w-20 rounded-md bg-[var(--color-surface-container-high)]" />
            <div className="h-6 w-24 rounded bg-[var(--color-surface-container)]" />
          </div>
        </div>
      ))}
    </div>
  )
}
