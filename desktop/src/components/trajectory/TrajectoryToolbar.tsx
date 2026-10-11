import type { ReactNode } from 'react'
import { ChevronRight, Clock, ListCollapse, Wrench } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { SearchField } from '@/components/ui/SearchField'
import { cx } from '@/lib/cx'
import { formatTokenCount } from '../../lib/trace/formatters'
import type { TrajectoryTotals } from '../../lib/trajectory/viewModel'

type Props = {
  durationMode: boolean
  onDurationModeChange: (value: boolean) => void
  turnsCollapsed: boolean
  onTurnsCollapsedChange: (value: boolean) => void
  toolsHidden: boolean
  onToolsHiddenChange: (value: boolean) => void
  query: string
  onQueryChange: (value: string) => void
  /** Matching rows while a search is active. */
  matchCount: number | null
  totals: TrajectoryTotals
  /** Older history is not loaded yet, so the totals cover only part of the session. */
  totalsPartial: boolean
  /** Subagent breadcrumb: shown when viewing a subagent's trajectory. */
  agentLabel: string | null
  onExitAgent: () => void
  /** Session controls after the search field: Stop, while 轨迹 hides the composer. */
  actions?: ReactNode
}

/** A labeled on/off toggle; icon-only toggles were too hard to discover. */
function ToggleButton({ pressed, onClick, icon, children, title }: { pressed: boolean; onClick: () => void; icon: ReactNode; children: ReactNode; title?: string }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      title={title}
      className={cx(
        'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-[var(--radius-sm)] px-2 text-[12px] transition-colors active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]',
        // A pressed toggle is the neutral selected fill; terracotta is kept for
        // the brand and selection marks, not on/off state.
        pressed
          ? 'bg-[var(--color-surface-selected)] font-medium text-[var(--color-text-primary)]'
          : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)]',
      )}
    >
      {icon}
      {children}
    </button>
  )
}

export function TrajectoryToolbar({
  durationMode,
  onDurationModeChange,
  turnsCollapsed,
  onTurnsCollapsedChange,
  toolsHidden,
  onToolsHiddenChange,
  query,
  onQueryChange,
  matchCount,
  totals,
  totalsPartial,
  agentLabel,
  onExitAgent,
  actions,
}: Props) {
  const t = useTranslation()
  const cacheBase = totals.input + totals.cacheRead + totals.cacheWrite
  const cacheHit = cacheBase > 0 ? (totals.cacheRead / cacheBase) * 100 : null
  const summary = [
    totalsPartial && totals.firstTurn !== null ? t('trajectory.toolbar.loadedFrom', { turn: totals.firstTurn }) : null,
    t('trajectory.toolbar.totals', {
      turns: totals.turns,
      steps: totals.steps,
      tools: totals.tools,
      tokens: formatTokenCount(cacheBase + totals.output),
    }),
    totals.errors > 0 ? t('trajectory.table.errorCount', { count: totals.errors }) : null,
    cacheHit !== null ? t('trajectory.toolbar.cacheHit', { percent: cacheHit.toFixed(cacheHit >= 99.95 ? 0 : 1) }) : null,
  ].filter(Boolean).join(' · ')
  return (
    <div className="flex h-10 shrink-0 items-center gap-1 border-b border-[var(--color-border)] px-3">
      <ToggleButton
        pressed={durationMode}
        onClick={() => onDurationModeChange(!durationMode)}
        icon={<Clock size={14} strokeWidth={1.75} aria-hidden />}
        title={t('trajectory.toolbar.durationHint')}
      >
        {t('trajectory.toolbar.duration')}
      </ToggleButton>
      <ToggleButton pressed={turnsCollapsed} onClick={() => onTurnsCollapsedChange(!turnsCollapsed)} icon={<ListCollapse size={14} strokeWidth={1.75} aria-hidden />}>
        {t('trajectory.toolbar.collapseTurns')}
      </ToggleButton>
      <ToggleButton pressed={toolsHidden} onClick={() => onToolsHiddenChange(!toolsHidden)} icon={<Wrench size={14} strokeWidth={1.75} aria-hidden />}>
        {t('trajectory.toolbar.hideTools')}
      </ToggleButton>
      {agentLabel && (
        <nav aria-label={t('trajectory.subagent.breadcrumb')} className="ml-2 flex min-w-0 items-center gap-1 text-[12px]">
          <button
            type="button"
            onClick={onExitAgent}
            className="shrink-0 rounded-[var(--radius-sm)] px-1 text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]"
          >
            {t('trajectory.subagent.main')}
          </button>
          <ChevronRight size={12} strokeWidth={2} aria-hidden className="shrink-0 text-[var(--color-text-tertiary)]" />
          <span className="truncate font-medium text-[var(--color-text-primary)]">{agentLabel}</span>
        </nav>
      )}
      <div className="ml-auto flex min-w-0 items-center gap-3">
        <span
          className="hidden min-w-0 truncate text-[12px] tabular-nums text-[var(--color-text-tertiary)] lg:inline"
          data-testid="trajectory-totals"
          title={t('trajectory.toolbar.totalsHint')}
        >
          {matchCount !== null ? t('trajectory.toolbar.matches', { count: matchCount }) : summary}
        </span>
        <SearchField
          value={query}
          onChange={onQueryChange}
          label={t('trajectory.toolbar.search')}
          placeholder={t('trajectory.toolbar.search')}
          clearable
          clearLabel={t('trajectory.toolbar.clearSearch')}
          size="sm"
          containerClassName="w-44"
        />
        {actions}
      </div>
    </div>
  )
}
