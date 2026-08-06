type ContextCategory = {
  name: string
  tokens: number
}

export type ContextUsageDetailsStatus = 'ready' | 'pending' | 'loading' | 'unavailable'

export type ContextUsageDetailsProps = {
  variant: 'popover' | 'sheet'
  modelLabel: string
  percentageLabel: string
  usedTokens: number
  freeTokens: number
  maxTokens: number
  categories: ContextCategory[]
  updatedAtLabel?: string
  estimate?: boolean
  status: ContextUsageDetailsStatus
  labels: {
    title: string
    used: string
    free: string
    window: string
    estimate: string
    pendingDetail: string
    loading: string
    unavailableDetail: string
  }
}

function formatNumber(value: number) {
  return new Intl.NumberFormat().format(value)
}

function CategoryBars({
  categories,
  maxTokens,
  density,
}: {
  categories: ContextCategory[]
  maxTokens: number
  density: 'compact' | 'comfortable'
}) {
  if (categories.length === 0) return null

  return (
    <div className={density === 'compact' ? 'mt-[18px] flex flex-col gap-3' : 'mt-5 space-y-3'}>
      {categories.map((category) => {
        const percent = maxTokens > 0
          ? Math.max(0.5, Math.min(100, (category.tokens / maxTokens) * 100))
          : 0
        return (
          <div key={category.name}>
            <div className={`flex items-baseline justify-between gap-3 ${density === 'compact' ? '' : 'text-xs'}`}>
              <span className={`min-w-0 truncate ${density === 'compact' ? 'text-[13.5px] text-[var(--color-text-primary)]' : 'text-[var(--color-text-secondary)]'}`}>
                {category.name}
              </span>
              <span className={`shrink-0 font-mono ${density === 'compact' ? 'text-[13px] text-[var(--color-text-secondary)]' : 'text-[var(--color-text-tertiary)]'}`}>
                {formatNumber(category.tokens)}
              </span>
            </div>
            <div className={`overflow-hidden rounded-full bg-[var(--color-surface-hover)] ${density === 'compact' ? 'mt-[7px] h-[3px]' : 'mt-1.5 h-1.5'}`}>
              <div className="h-full rounded-full bg-[var(--color-brand)]" style={{ width: `${percent}%` }} />
            </div>
          </div>
        )
      })}
    </div>
  )
}

/**
 * Shared context-usage body for the desktop popover and mobile/H5 sheet.
 * Presentation shells own chrome (portal, sheet header); this only paints data.
 */
export function ContextUsageDetails({
  variant,
  modelLabel,
  percentageLabel,
  usedTokens,
  freeTokens,
  maxTokens,
  categories,
  updatedAtLabel,
  estimate = false,
  status,
  labels,
}: ContextUsageDetailsProps) {
  if (variant === 'sheet') {
    return (
      <div data-testid="context-usage-details" data-variant="sheet">
        <div className="flex items-end justify-between gap-4">
          <div
            className="text-4xl font-bold leading-none text-[var(--color-text-primary)]"
            style={{ fontFamily: 'var(--font-headline)' }}
          >
            {percentageLabel}
          </div>
          {estimate && status === 'ready' && (
            <span className="mb-1 rounded-full border border-[var(--color-border)] px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--color-text-tertiary)]">
              {labels.estimate}
            </span>
          )}
        </div>

        {status === 'ready' ? (
          <div className="mt-5">
            <div className="grid grid-cols-3 gap-2 font-mono text-xs">
              <div className="rounded-[var(--radius-lg)] bg-[var(--color-surface-container)] p-3">
                <div className="text-[var(--color-text-tertiary)]">{labels.used}</div>
                <div className="mt-1 text-[var(--color-text-primary)]">{formatNumber(usedTokens)}</div>
              </div>
              <div className="rounded-[var(--radius-lg)] bg-[var(--color-surface-container)] p-3">
                <div className="text-[var(--color-text-tertiary)]">{labels.free}</div>
                <div className="mt-1 text-[var(--color-text-primary)]">{formatNumber(freeTokens)}</div>
              </div>
              <div className="rounded-[var(--radius-lg)] bg-[var(--color-surface-container)] p-3">
                <div className="text-[var(--color-text-tertiary)]">{labels.window}</div>
                <div className="mt-1 text-[var(--color-text-primary)]">{maxTokens > 0 ? formatNumber(maxTokens) : '--'}</div>
              </div>
            </div>
            <CategoryBars categories={categories} maxTokens={maxTokens} density="comfortable" />
            {updatedAtLabel && (
              <div className="mt-4 text-[11px] text-[var(--color-text-tertiary)]">
                {updatedAtLabel}
              </div>
            )}
          </div>
        ) : (
          <div className="mt-5 rounded-[var(--radius-lg)] bg-[var(--color-surface-container)] p-4 text-sm leading-6 text-[var(--color-text-secondary)]">
            {status === 'pending'
              ? labels.pendingDetail
              : status === 'loading'
                ? labels.loading
                : labels.unavailableDetail}
          </div>
        )}
      </div>
    )
  }

  return (
    <div data-testid="context-usage-details" data-variant="popover">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs font-semibold tracking-[0.08em] text-[var(--color-text-tertiary)]">
            {labels.title}
          </div>
          <div className="mt-1 truncate text-base font-bold text-[var(--color-text-primary)]">
            {modelLabel}
          </div>
        </div>
        {/* The headline serif carries the one large number on the panel —
            the same treatment the handoff gives every hero statistic. */}
        <div
          className="shrink-0 text-[27px] font-bold leading-none text-[var(--color-text-primary)]"
          style={{ fontFamily: 'var(--font-headline)' }}
        >
          {percentageLabel}
        </div>
      </div>

      {status === 'ready' ? (
        <>
          <div className="mt-4 grid grid-cols-2 gap-2">
            <div>
              <div className="text-[12.5px] text-[var(--color-text-tertiary)]">{labels.used}</div>
              <div className="mt-[3px] font-mono text-sm font-medium text-[var(--color-text-primary)]">{formatNumber(usedTokens)}</div>
            </div>
            <div>
              <div className="text-[12.5px] text-[var(--color-text-tertiary)]">{labels.free}</div>
              <div className="mt-[3px] font-mono text-sm font-medium text-[var(--color-text-primary)]">{formatNumber(freeTokens)}</div>
            </div>
            <div className="col-span-2 mt-1">
              <div className="text-[12.5px] text-[var(--color-text-tertiary)]">{labels.window}</div>
              <div className="mt-[3px] font-mono text-sm font-medium text-[var(--color-text-primary)]">{maxTokens > 0 ? formatNumber(maxTokens) : '--'}</div>
            </div>
          </div>
          <CategoryBars categories={categories} maxTokens={maxTokens} density="compact" />
          {updatedAtLabel && (
            <div className="mt-4 text-xs text-[var(--color-text-tertiary)]">
              {updatedAtLabel}
              {estimate && (
                <span className="ml-2 inline-flex rounded-full border border-[var(--color-border)] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em]">
                  {labels.estimate}
                </span>
              )}
            </div>
          )}
        </>
      ) : status === 'pending' ? (
        <div className="mt-4 text-sm leading-6 text-[var(--color-text-secondary)]">
          {labels.pendingDetail}
        </div>
      ) : (
        <div className="mt-4 text-sm leading-6 text-[var(--color-text-secondary)]">
          {status === 'loading' ? labels.loading : labels.unavailableDetail}
        </div>
      )}
    </div>
  )
}
