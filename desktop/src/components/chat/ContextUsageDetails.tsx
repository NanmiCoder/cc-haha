import { useState } from 'react'
import { ChevronRight } from 'lucide-react'
import {
  formatCacheHitRate,
  formatCompactTokens,
  formatTokensPerSecond,
} from '../../lib/sessionUsageMetrics'

type ContextCategory = {
  name: string
  tokens: number
  /** Server-assigned segment color; the segmented bar paints it directly. */
  color?: string
}

/**
 * Lifetime figures for the whole session, as opposed to `categories` which describe only what
 * currently occupies the context window. Kept as raw numbers so the formatting rules (never
 * rounding a cache hit up to 100%, withholding a speed with no API duration) stay in one place.
 */
export type ContextUsageSessionStats = {
  cacheHitRate: number | null
  tokensPerSecond: number | null
  /** Pre-formatted by the server (unknown-model sessions included), displayed verbatim. */
  costDisplay: string
}

export type ContextUsageDetailsStatus = 'ready' | 'pending' | 'loading' | 'unavailable'

export type ContextUsageDetailsProps = {
  variant: 'popover' | 'sheet'
  modelLabel: string
  /** Remaining-window headline (e.g. "79%") — the number the user actually budgets against. */
  remainingLabel: string
  usedTokens: number
  maxTokens: number
  categories: ContextCategory[]
  sessionStats?: ContextUsageSessionStats | null
  updatedAtLabel?: string
  estimate?: boolean
  status: ContextUsageDetailsStatus
  labels: {
    title: string
    remaining: string
    used: string
    window: string
    estimate: string
    pendingDetail: string
    loading: string
    unavailableDetail: string
    breakdown: string
    sessionCacheHit: string
    sessionSpeed: string
    sessionCost: string
    sessionSpeedUnit: string
  }
}

function formatNumber(value: number) {
  return new Intl.NumberFormat().format(value)
}

/**
 * One fill for the whole window, in the app's brand color, sized by how much of the window is
 * used. Category colors cannot paint this: the CLI names them with terminal theme keys
 * (`promptBorder`, `inactive`), which are not CSS colors, so a segment styled with one renders
 * transparent and the track looks empty no matter how full the window is. The per-category
 * split stays behind the breakdown toggle.
 */
function UsageMeter({
  usedTokens,
  maxTokens,
  label,
}: {
  usedTokens: number
  maxTokens: number
  label: string
}) {
  if (maxTokens <= 0) return null
  const percent = Math.max(0, Math.min(100, (usedTokens / maxTokens) * 100))
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(percent)}
      className="h-[6px] overflow-hidden rounded-full bg-[var(--color-surface-hover)]"
      data-testid="context-segmented-bar"
    >
      <div
        data-testid="context-usage-fill"
        className="h-full rounded-full bg-[var(--color-brand)]"
        style={{ width: `${percent}%` }}
      />
    </div>
  )
}

/**
 * The three numbers a user watches while a session runs: how fast it is generating, how much of
 * the prompt is being served from cache, and what the session has cost so far.
 */
function SessionStatGrid({
  stats,
  labels,
  density,
}: {
  stats: ContextUsageSessionStats
  labels: ContextUsageDetailsProps['labels']
  density: 'compact' | 'comfortable'
}) {
  const labelClass = density === 'compact'
    ? 'text-[12.5px] text-[var(--color-text-tertiary)]'
    : 'text-xs text-[var(--color-text-tertiary)]'
  const valueClass = 'mt-[3px] font-mono text-sm text-[var(--color-text-primary)]'

  return (
    <div className="mt-4 grid grid-cols-3 gap-3">
      <div>
        <div className={labelClass}>{labels.sessionSpeed}</div>
        <div className={valueClass} data-testid="session-speed">
          {formatTokensPerSecond(stats.tokensPerSecond ?? 0)}
          {stats.tokensPerSecond !== null && (
            <span className="ml-1 text-[11px] text-[var(--color-text-tertiary)]">{labels.sessionSpeedUnit}</span>
          )}
        </div>
      </div>
      <div>
        <div className={labelClass}>{labels.sessionCacheHit}</div>
        <div className={valueClass} data-testid="session-cache-hit">
          {stats.cacheHitRate === null ? '--' : formatCacheHitRate(stats.cacheHitRate)}
        </div>
      </div>
      <div>
        <div className={labelClass}>{labels.sessionCost}</div>
        <div className={`${valueClass} truncate`} data-testid="session-cost" title={stats.costDisplay}>
          {stats.costDisplay}
        </div>
      </div>
    </div>
  )
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
    <div className={density === 'compact' ? 'mt-3 flex flex-col gap-3' : 'mt-4 space-y-3'}>
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
              <div
                className="h-full rounded-full"
                style={{ width: `${percent}%`, backgroundColor: category.color || 'var(--color-brand)' }}
              />
            </div>
          </div>
        )
      })}
    </div>
  )
}

/**
 * Ready-state body shared by both shells. Order is the user's question order: how much window is
 * left, how the session is performing, then (collapsed) what the window is made of.
 */
function ReadyBody({
  variant,
  remainingLabel,
  usedTokens,
  maxTokens,
  categories,
  sessionStats,
  updatedAtLabel,
  labels,
}: {
  variant: 'popover' | 'sheet'
} & Pick<
  ContextUsageDetailsProps,
  'remainingLabel' | 'usedTokens' | 'maxTokens' | 'categories' | 'sessionStats' | 'updatedAtLabel' | 'labels'
>) {
  const density = variant === 'sheet' ? 'comfortable' : 'compact'
  const [breakdownOpen, setBreakdownOpen] = useState(false)

  return (
    <>
      <div className="mt-3 flex items-baseline justify-between gap-3">
        <div className="text-[12.5px] text-[var(--color-text-tertiary)]">{labels.remaining}</div>
        {/* The headline serif carries the one large number on the panel —
            the same treatment the handoff gives every hero statistic. */}
        <div
          className="shrink-0 text-[27px] font-bold leading-none text-[var(--color-text-primary)]"
          style={{ fontFamily: 'var(--font-headline)' }}
          data-testid="context-remaining"
        >
          {remainingLabel}
        </div>
      </div>

      <div className="mt-3">
        <UsageMeter usedTokens={usedTokens} maxTokens={maxTokens} label={labels.used} />
      </div>

      {/* This timestamp describes the window composition, so it sits with the used/window figures
          rather than next to the live session totals. */}
      <div className="mt-2 text-[11px] text-[var(--color-text-tertiary)]">
        {labels.used} {formatNumber(usedTokens)}
        {' · '}
        {labels.window} {maxTokens > 0 ? formatNumber(maxTokens) : '--'}
        {updatedAtLabel && (
          <>
            {' · '}
            {updatedAtLabel}
          </>
        )}
      </div>

      {sessionStats && (
        <SessionStatGrid stats={sessionStats} labels={labels} density={density} />
      )}

      {categories.length > 0 && (
        <div className="mt-3 border-t border-[var(--color-border)] pt-2.5">
          <button
            type="button"
            aria-expanded={breakdownOpen}
            onClick={() => setBreakdownOpen((open) => !open)}
            data-testid="context-breakdown-toggle"
            className="flex w-full items-center justify-between gap-3 rounded-[var(--radius-sm)] text-left text-[12.5px] text-[var(--color-text-secondary)] transition-colors duration-150 hover:text-[var(--color-text-primary)]"
          >
            <span className="flex items-center gap-1.5">
              <ChevronRight
                className={`h-3.5 w-3.5 transition-transform duration-150 ${breakdownOpen ? 'rotate-90' : ''}`}
              />
              {labels.breakdown}
            </span>
            <span className="shrink-0 font-mono text-[11px] text-[var(--color-text-tertiary)]">
              {formatCompactTokens(usedTokens)}
            </span>
          </button>
          {breakdownOpen && (
            <CategoryBars categories={categories} maxTokens={maxTokens} density={density} />
          )}
        </div>
      )}
    </>
  )
}

/**
 * Shared context-usage body for the desktop popover and mobile/H5 sheet.
 * Presentation shells own chrome (portal, sheet header); this only paints data.
 */
export function ContextUsageDetails({
  variant,
  modelLabel,
  remainingLabel,
  usedTokens,
  maxTokens,
  categories,
  sessionStats,
  updatedAtLabel,
  estimate = false,
  status,
  labels,
}: ContextUsageDetailsProps) {
  const statusMessage = status === 'pending'
    ? labels.pendingDetail
    : status === 'loading'
      ? labels.loading
      : labels.unavailableDetail

  const body = status === 'ready' ? (
    <ReadyBody
      variant={variant}
      remainingLabel={remainingLabel}
      usedTokens={usedTokens}
      maxTokens={maxTokens}
      categories={categories}
      sessionStats={sessionStats}
      updatedAtLabel={updatedAtLabel}
      labels={labels}
    />
  ) : (
    <div className={variant === 'sheet'
      ? 'mt-5 rounded-[var(--radius-lg)] bg-[var(--color-surface-container)] p-4 text-sm leading-6 text-[var(--color-text-secondary)]'
      : 'mt-4 text-sm leading-6 text-[var(--color-text-secondary)]'
    }>
      {statusMessage}
    </div>
  )

  if (variant === 'sheet') {
    // The sheet shell already shows title + model in its header, so the body skips them.
    return (
      <div data-testid="context-usage-details" data-variant="sheet">
        {estimate && status === 'ready' && (
          <span className="inline-flex rounded-full border border-[var(--color-border)] px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--color-text-tertiary)]">
            {labels.estimate}
          </span>
        )}
        {body}
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
        {estimate && status === 'ready' && (
          <span className="shrink-0 rounded-full border border-[var(--color-border)] px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--color-text-tertiary)]">
            {labels.estimate}
          </span>
        )}
      </div>
      {body}
    </div>
  )
}
