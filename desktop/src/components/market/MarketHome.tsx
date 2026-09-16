import { forwardRef, useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowUpRight, CloudOff, PackageSearch, RefreshCw, Search, Sparkles, Store, X } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { ErrorState } from '@/components/ui/ErrorState'
import { IconButton } from '@/components/ui/IconButton'
import { SkeletonCards } from '@/components/ui/Skeleton'
import { useMarketStore } from '../../stores/marketStore'
import { SETTINGS_TAB_ID, useTabStore } from '../../stores/tabStore'
import { useUIStore } from '../../stores/uiStore'
import { FilterBar } from './FilterBar'
import { MarketDisclaimer } from './MarketDisclaimer'
import { SkillCard } from './SkillCard'
import { SourceStatusBar } from './SourceStatusBar'
import {
  CATALOG_CARD_MIN_HEIGHT,
  CATALOG_GAP,
  CATALOG_GRID_TEMPLATE,
  useMarketGridFill,
} from './useMarketGridFill'

/**
 * Starts the next page while the last row is still on screen, so the skeleton
 * is a hint that more is coming rather than a wall the reader hits.
 */
const PREFETCH_MARGIN = '400px'

const CATALOG_GRID_STYLE = { gridTemplateColumns: CATALOG_GRID_TEMPLATE, gap: CATALOG_GAP }

export function MarketHome({ onRequestInstall, featured }: { onRequestInstall: (id: string) => void, featured?: ReactNode }) {
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
    loadMoreError,
    fetchList,
    loadMore,
    setQuery,
    installingIds,
  } = useMarketStore()

  const scrollRef = useRef<HTMLDivElement | null>(null)
  const sentinelRef = useRef<HTMLDivElement | null>(null)
  const { measureRef, columns, count: skeletonCount } = useMarketGridFill()
  /**
   * Every shell this runs in supports the observer; the manual button stays as
   * the fallback so a runtime without it (or a test) can still page through
   * instead of the list simply ending.
   */
  const [canAutoLoad] = useState(() => typeof IntersectionObserver === 'function')

  useEffect(() => {
    if (items.length === 0 && !isLoading && !error) {
      void fetchList({ reset: true })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    // A failed page stops the auto-loading: the observer would otherwise walk
    // straight back into the same failure the moment the skeleton unmounts.
    if (!canAutoLoad || !nextCursor || isLoading || isLoadingMore || loadMoreError) return
    const sentinel = sentinelRef.current
    if (!sentinel) return

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void loadMore()
      },
      { root: scrollRef.current, rootMargin: PREFETCH_MARGIN },
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
    // Re-observing after each page is what keeps a tall window filling: an
    // observer only reports *changes*, so a sentinel that never left the
    // viewport would fire once and then stall with half a screen of content.
  }, [canAutoLoad, nextCursor, isLoading, isLoadingMore, loadMoreError, loadMore])

  const openInstalledSkills = useCallback(() => {
    useUIStore.getState().setPendingSettingsTab('skills')
    useTabStore.getState().openTab(SETTINGS_TAB_ID, t('sidebar.settings'), 'settings')
  }, [t])

  const hasActiveFilters =
    filters.source !== 'all' || filters.security !== 'all' || filters.installed !== 'all'
  const hasQuery = query.trim().length > 0

  return (
    <div
      ref={scrollRef}
      data-testid="market-scroll"
      className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-[var(--color-surface)]"
    >
      <div className="mx-auto flex w-full max-w-[1280px] flex-col px-6 pb-10 pt-7 lg:px-10">
        <header className="flex flex-wrap items-start gap-x-[18px] gap-y-4">
          <span className="flex h-14 w-14 flex-shrink-0 items-center justify-center rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-brand)] shadow-[var(--shadow-card)]">
            <Store className="h-[26px] w-[26px]" strokeWidth={1.4} aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <h1
              style={{ fontFamily: 'var(--font-headline)' }}
              className="text-[26px] font-bold leading-9 tracking-[-0.012em] text-[var(--color-text-primary)]"
            >
              {t('market.title')}
            </h1>
            <p className="mt-1 max-w-2xl text-[15px] leading-6 text-[var(--color-text-secondary)]">
              {t('market.subtitle')}
            </p>
          </div>
          {/* The live-source dots and the way out of the catalogue read as one
              cluster: what the shelves are serving on top, what is already on
              the reader's machine under it, both flush right so the header
              keeps a single trailing edge. */}
          <div className="flex flex-col items-end gap-2.5 pt-2">
            <SourceStatusBar sources={sources} />
            <Button
              variant="secondary"
              size="md"
              data-testid="market-installed-entry"
              title={t('market.installedSkillsHint')}
              onClick={openInstalledSkills}
              className="gap-2 pr-3"
              icon={
                <Sparkles className="h-4 w-4 text-[var(--color-brand)]" strokeWidth={1.6} aria-hidden="true" />
              }
            >
              {t('market.installedSkills')}
              <ArrowUpRight
                className="h-3.5 w-3.5 text-[var(--color-text-tertiary)]"
                strokeWidth={1.8}
                aria-hidden="true"
              />
            </Button>
          </div>
        </header>

        <MarketDisclaimer />

        <div className="mt-[22px] flex flex-wrap items-center gap-3">
          {/* Kept hand-rolled rather than moved onto `SearchField`: the command
              bar is a 44px field on the `--radius-lg` step, and the shared
              component tops out at h-10 / `--radius-md`. Overriding both from a
              className is the class fight components/AGENTS.md §3.6 warns about. */}
          <div className="flex min-h-11 min-w-[240px] flex-1 items-center gap-2.5 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] px-4 transition-colors focus-within:border-[var(--color-border-focus)] focus-within:shadow-[var(--shadow-focus-ring)]">
            <Search className="h-[15px] w-[15px] flex-shrink-0 text-[var(--color-text-tertiary)]" strokeWidth={1.6} aria-hidden="true" />
            <input
              data-testid="market-search-input"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('market.searchPlaceholder')}
              aria-label={t('market.searchPlaceholder')}
              className="min-w-0 flex-1 bg-transparent text-[14.5px] text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-tertiary)]"
            />
            {query && (
              <IconButton
                icon={<X className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />}
                label={t('market.clearSearch')}
                size="sm"
                tone="muted"
                onClick={() => setQuery('')}
              />
            )}
          </div>
          <FilterBar />
        </div>

        {featured}

        {!isLoading && items.length > 0 && (
          <p className="mb-4 mt-5 text-sm tabular-nums text-[var(--color-text-secondary)]">
            {t('market.resultCount', { count: String(items.length) })}
          </p>
        )}

        {isLoading && (
          <MarketGridSkeleton
            ref={measureRef}
            label={t('market.loading')}
            count={skeletonCount}
            testId="market-loading"
            className="mt-5"
          />
        )}

        {/* Kept as a bespoke region-level state rather than `ErrorState`: that
            component is the compact left-aligned inline notice, and the three
            market failure regions are full-height centered states with an icon.
            `EmptyState` has no danger tone. What did change: the `/35` and `/25`
            alpha modifiers are gone — Safari 15 WebView drops that color
            function outright, which rendered this banner as bare text on the
            desktop shell — and the failure now announces itself. */}
        {!isLoading && error && (
          <div
            role="alert"
            data-testid="market-error"
            className="mt-5 flex flex-col items-center gap-3 rounded-[var(--radius-xl)] border border-dashed border-[var(--color-error-soft-hover)] bg-[var(--color-error-soft)] px-6 py-14 text-center"
          >
            <CloudOff className="h-8 w-8 text-[var(--color-error)]" strokeWidth={1.7} aria-hidden="true" />
            <p className="text-sm font-medium text-[var(--color-text-primary)]">{t('market.error.list')}</p>
            <p className="max-w-md break-words text-xs text-[var(--color-text-tertiary)]">{error}</p>
            <Button
              variant="secondary"
              className="mt-1"
              icon={<RefreshCw className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />}
              onClick={() => void fetchList({ reset: true })}
            >
              {t('market.retry')}
            </Button>
          </div>
        )}

        {!isLoading && !error && items.length === 0 && (
          <div data-testid="market-empty" className="mt-5">
            <EmptyState
              size="lg"
              icon={
                hasQuery || hasActiveFilters
                  ? <PackageSearch size={24} strokeWidth={1.6} />
                  : <Store size={24} strokeWidth={1.6} />
              }
              title={hasQuery || hasActiveFilters ? t('market.emptySearch') : t('market.empty')}
              description={hasQuery || hasActiveFilters ? t('market.emptySearchHint') : t('market.emptyHint')}
              action={
                hasQuery
                  ? { label: t('market.clearSearch'), onClick: () => setQuery('') }
                  : { label: t('market.retry'), onClick: () => void fetchList({ reset: true }) }
              }
            />
          </div>
        )}

        {!isLoading && items.length > 0 && (
          <>
            <div
              ref={measureRef}
              className="grid"
              style={CATALOG_GRID_STYLE}
              data-testid="market-grid"
            >
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
              <>
                {/* Sits flush against the grid's bottom edge, so the prefetch
                    margin is measured from the last row rather than from
                    whatever state is drawn below it. */}
                <div
                  ref={sentinelRef}
                  data-testid="market-load-more-sentinel"
                  aria-hidden="true"
                  className="h-px w-full"
                />

                {isLoadingMore && (
                  <MarketGridSkeleton
                    label={t('market.loadingMore')}
                    count={columns}
                    testId="market-loading-more"
                    style={{ marginTop: CATALOG_GAP }}
                  />
                )}

                {loadMoreError && !isLoadingMore && (
                  <ErrorState
                    title={t('market.loadMoreError')}
                    detail={loadMoreError}
                    onRetry={() => void loadMore()}
                    retryLabel={t('market.retry')}
                    className="mx-auto mt-7 max-w-md items-center text-center"
                  />
                )}

                {!canAutoLoad && !isLoadingMore && !loadMoreError && (
                  <div className="flex justify-center pt-7">
                    <Button
                      variant="secondary"
                      size="lg"
                      data-testid="market-load-more"
                      onClick={() => void loadMore()}
                    >
                      {t('market.loadMore')}
                    </Button>
                  </div>
                )}
              </>
            )}
          </>
        )}
      </div>
    </div>
  )
}

type MarketGridSkeletonProps = {
  label: string
  count: number
  testId: string
  className?: string
  style?: React.CSSProperties
}

const MarketGridSkeleton = forwardRef<HTMLDivElement, MarketGridSkeletonProps>(
  function MarketGridSkeleton({ label, count, testId, className, style }, ref) {
    return (
      <div ref={ref} data-testid={testId} className={className} style={style}>
        <SkeletonCards
          label={label}
          count={count}
          minHeight={`${CATALOG_CARD_MIN_HEIGHT}px`}
          withAvatar
          style={CATALOG_GRID_STYLE}
        />
      </div>
    )
  },
)
