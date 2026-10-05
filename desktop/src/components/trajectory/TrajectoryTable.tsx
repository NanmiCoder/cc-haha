import { Fragment, memo, useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { ChevronDown, ChevronRight, CircleX } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { Badge } from '@/components/ui/Badge'
import { cx } from '@/lib/cx'
import { formatBytes } from '../../lib/formatBytes'
import { formatDurationMs, formatTokenCount } from '../../lib/trace/formatters'
import { hasUsage, isOrphanTool, rowDurationMs, toolHasResult, type TrajectoryItem } from '../../lib/trajectory/viewModel'
import { useFixedRowWindow, visibleRange, type ScrollAlign } from '../../lib/trajectory/useFixedRowWindow'
import type { TrajectoryRow } from '../../types/trajectory'
import { KIND_LABEL_KEYS, KIND_TONES, KIND_VARIANTS, contextLabel, systemRowTitle, turnLabel, userLabel } from './trajectoryLabels'

export const TRAJECTORY_ROW_HEIGHT = 30

export type TableScrollRequest = { index: number; nonce: number; align: ScrollAlign; offset?: number }

export type TableRange = {
  /** First and last visible item index (no overscan). */
  first: number
  last: number
  /** Pixel distance of the first visible item's top from the viewport top. */
  firstOffset: number
  atBottom: boolean
}

type Props = {
  items: readonly TrajectoryItem[]
  selectedId: string | null
  collapsedTurns: ReadonlySet<number>
  /** Search terms to highlight in visible rows. */
  terms: readonly string[]
  /** A turn is running, so a tool without a result is still executing. */
  running: boolean
  onSelect: (rowId: string) => void
  onToggleTurn: (turn: number) => void
  onEscape: () => void
  scrollRequest: TableScrollRequest | null
  onRangeChange?: (range: TableRange) => void
  /** Rendered as the first line when older history exists. */
  header?: ReactNode
}

export function TrajectoryTable({
  items,
  selectedId,
  collapsedTurns,
  terms,
  running,
  onSelect,
  onToggleTurn,
  onEscape,
  scrollRequest,
  onRangeChange,
  header,
}: Props) {
  const t = useTranslation()
  const scrollerRef = useRef<HTMLDivElement>(null)
  const headerRows = header ? 1 : 0
  const total = items.length + headerRows
  const { start, end, scrollTop, viewportHeight, scrollToIndex } = useFixedRowWindow(scrollerRef, { count: total, rowHeight: TRAJECTORY_ROW_HEIGHT })

  useEffect(() => {
    if (!scrollRequest) return
    scrollToIndex(scrollRequest.index + headerRows, scrollRequest.align, scrollRequest.offset)
  }, [headerRows, scrollRequest, scrollToIndex])

  useEffect(() => {
    if (!onRangeChange) return
    const visible = visibleRange(scrollTop, viewportHeight, TRAJECTORY_ROW_HEIGHT, total)
    const first = Math.max(0, visible.first - headerRows)
    onRangeChange({
      first,
      last: Math.max(first, visible.last - headerRows),
      firstOffset: (first + headerRows) * TRAJECTORY_ROW_HEIGHT - scrollTop,
      atBottom: visible.last >= total - 1,
    })
  }, [headerRows, onRangeChange, scrollTop, total, viewportHeight])

  const selectedIndex = selectedId ? items.findIndex((item) => item.type === 'row' && item.row.id === selectedId) : -1
  const pageRows = Math.max(1, Math.floor(viewportHeight / TRAJECTORY_ROW_HEIGHT) - 1)

  const selectAt = (target: number, direction: 1 | -1) => {
    let index = Math.max(0, Math.min(items.length - 1, target))
    while (index >= 0 && index < items.length && items[index]!.type !== 'row') index += direction
    if (index < 0 || index >= items.length) {
      index = Math.max(0, Math.min(items.length - 1, target))
      while (index >= 0 && index < items.length && items[index]!.type !== 'row') index -= direction
    }
    const item = items[index]
    if (item?.type === 'row') {
      onSelect(item.row.id)
      scrollToIndex(index + headerRows)
    }
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const from = selectedIndex < 0 ? -1 : selectedIndex
    switch (event.key) {
      case 'ArrowDown': selectAt(from + 1, 1); break
      case 'ArrowUp': selectAt(from < 0 ? items.length - 1 : from - 1, -1); break
      case 'PageDown': selectAt(from + pageRows, 1); break
      case 'PageUp': selectAt(Math.max(0, from - pageRows), -1); break
      case 'Home': selectAt(0, 1); break
      case 'End': selectAt(items.length - 1, -1); break
      case 'Escape': onEscape(); break
      default: return
    }
    event.preventDefault()
  }

  const rendered = []
  let selectedRendered = false
  for (let index = start; index < end; index++) {
    const top = index * TRAJECTORY_ROW_HEIGHT
    if (headerRows && index === 0) {
      rendered.push(
        <div key="__header" role="presentation" className="absolute inset-x-0 flex items-center justify-center" style={{ top, height: TRAJECTORY_ROW_HEIGHT }}>
          {header}
        </div>,
      )
      continue
    }
    const item = items[index - headerRows]
    if (!item) continue
    if (item.type === 'row' && item.row.id === selectedId) selectedRendered = true
    rendered.push(
      <div key={item.key} role="presentation" className="absolute inset-x-0" style={{ top, height: TRAJECTORY_ROW_HEIGHT }}>
        {item.type === 'row' ? (
          <TrajectoryRowView
            item={item}
            selected={item.row.id === selectedId}
            collapsed={item.row.turn !== null && collapsedTurns.has(item.row.turn)}
            terms={terms}
            running={running}
            onSelect={onSelect}
            onToggleTurn={onToggleTurn}
          />
        ) : (
          <button
            type="button"
            onClick={() => onToggleTurn(item.turn)}
            className="flex h-full w-full items-center gap-2 pl-[120px] pr-3 text-left text-[12px] text-[var(--color-text-tertiary)] hover:bg-[var(--color-surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-border-focus)]"
          >
            <span>{t('trajectory.table.folded', { count: item.hiddenRows })}</span>
            {item.toolCount > 0 && <span>· {t('trajectory.table.toolCount', { count: item.toolCount })}</span>}
            {item.errors > 0 && <span className="text-[var(--color-error)]">· {t('trajectory.table.errorCount', { count: item.errors })}</span>}
            {item.durationMs > 0 && <span className="font-mono text-[11px] tabular-nums">· {formatDurationMs(item.durationMs)}</span>}
          </button>
        )}
      </div>,
    )
  }

  return (
    <div
      ref={scrollerRef}
      role="listbox"
      aria-label={t('trajectory.table.label')}
      aria-activedescendant={selectedId && selectedRendered ? rowDomId(selectedId) : undefined}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      data-testid="trajectory-table"
      className="relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-border-focus)]"
    >
      <div className="relative" style={{ height: total * TRAJECTORY_ROW_HEIGHT }}>
        {rendered}
      </div>
    </div>
  )
}

function rowDomId(rowId: string) {
  return `trajectory-row-${rowId.replace(/[^A-Za-z0-9_-]/g, '_')}`
}

type RowProps = {
  item: Extract<TrajectoryItem, { type: 'row' }>
  selected: boolean
  collapsed: boolean
  terms: readonly string[]
  running: boolean
  onSelect: (rowId: string) => void
  onToggleTurn: (turn: number) => void
}

const TrajectoryRowView = memo(function TrajectoryRowView({ item, selected, collapsed, terms, running, onSelect, onToggleTurn }: RowProps) {
  const t = useTranslation()
  const { row, turnStart, hiddenTools } = item
  const duration = rowDurationMs(row)
  return (
    <div
      className={cx(
        'group flex h-full items-center border-l-2 pr-3 text-[13px]',
        selected
          ? 'border-l-[var(--color-brand)] bg-[var(--color-surface-selected)]'
          : 'border-l-transparent hover:bg-[var(--color-surface-hover)]',
        turnStart && 'border-t border-t-[var(--color-border)]',
      )}
    >
      {/* The fold toggle sits beside the option, not inside it: an option may not contain other controls. */}
      <div className="flex w-[72px] shrink-0 items-center justify-end pr-1">
        {turnStart && row.turn !== null && (
          <button
            type="button"
            onClick={() => onToggleTurn(row.turn!)}
            aria-expanded={!collapsed}
            aria-label={t(collapsed ? 'trajectory.table.expandTurn' : 'trajectory.table.collapseTurn', { turn: turnLabel(row.turn, t) })}
            className="flex items-center gap-0.5 rounded-[var(--radius-xs)] px-1 text-[11px] font-medium text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]"
          >
            {collapsed ? <ChevronRight size={12} strokeWidth={2} aria-hidden /> : <ChevronDown size={12} strokeWidth={2} aria-hidden />}
            <span className="whitespace-nowrap">{turnLabel(row.turn, t)}</span>
          </button>
        )}
      </div>
      <div
        id={rowDomId(row.id)}
        role="option"
        aria-selected={selected}
        data-row-id={row.id}
        data-kind={row.kind}
        onClick={() => onSelect(row.id)}
        className="flex h-full min-w-0 flex-1 cursor-default items-center gap-2"
      >
        <Badge tone={row.isError ? 'danger' : KIND_TONES[row.kind]} variant={KIND_VARIANTS[row.kind]} size="xs" pill={false} className="min-w-11 justify-center">
          {t(KIND_LABEL_KEYS[row.kind])}
        </Badge>
        {row.isError && <CircleX size={14} strokeWidth={1.75} aria-label={t('trajectory.status.error')} className="shrink-0 text-[var(--color-error)]" />}
        <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden whitespace-nowrap">
          <RowContent row={row} hiddenTools={hiddenTools} terms={terms} running={running} />
        </div>
        {row.kind === 'assistant' && hasUsage(row) && (
          <span
            className="shrink-0 font-mono text-[11px] tabular-nums text-[var(--color-text-tertiary)]"
            title={t('trajectory.table.usageTitle')}
          >
            {t('trajectory.table.usageShort', {
              input: formatTokenCount(row.usage!.input + row.usage!.cacheRead + row.usage!.cacheWrite),
              output: formatTokenCount(row.usage!.output),
            })}
          </span>
        )}
        <span className="w-14 shrink-0 text-right font-mono text-[11px] tabular-nums text-[var(--color-text-tertiary)]">
          {duration !== null ? formatDurationMs(duration) : ''}
        </span>
      </div>
    </div>
  )
})

/** Wraps search hits in <mark>; only visible rows render, so this stays cheap. */
function Highlight({ text, terms }: { text: string; terms: readonly string[] }) {
  if (!terms.length || !text) return <>{text}</>
  const lower = text.toLowerCase()
  const marks: Array<[number, number]> = []
  for (const term of terms) {
    let at = lower.indexOf(term)
    while (at >= 0 && marks.length < 32) {
      marks.push([at, at + term.length])
      at = lower.indexOf(term, at + term.length)
    }
  }
  if (!marks.length) return <>{text}</>
  marks.sort((a, b) => a[0] - b[0])
  const parts: ReactNode[] = []
  let cursor = 0
  marks.forEach(([from, to], index) => {
    if (from < cursor) return
    if (from > cursor) parts.push(text.slice(cursor, from))
    parts.push(<mark key={index} className="rounded-[var(--radius-xs)] bg-[var(--color-search-highlight)] text-[var(--color-on-search-highlight)]">{text.slice(from, to)}</mark>)
    cursor = to
  })
  parts.push(text.slice(cursor))
  return <>{parts.map((part, index) => <Fragment key={index}>{part}</Fragment>)}</>
}

function RowContent({ row, hiddenTools, terms, running }: {
  row: TrajectoryRow
  hiddenTools: Extract<TrajectoryItem, { type: 'row' }>['hiddenTools']
  terms: readonly string[]
  running: boolean
}) {
  const t = useTranslation()
  const muted = 'truncate text-[var(--color-text-tertiary)]'
  switch (row.kind) {
    case 'system': {
      const details = [
        row.snapshot?.sysChars ? t('trajectory.system.chars', { count: row.snapshot.sysChars.toLocaleString() }) : null,
        row.snapshot?.toolCount ? t('trajectory.table.toolCount', { count: row.snapshot.toolCount }) : null,
        row.snapshot?.scope && row.snapshot.scope !== 'main' ? row.snapshot.scope : null,
      ].filter(Boolean).join(' · ')
      return (
        <>
          <span className="shrink-0 text-[var(--color-text-primary)]">{systemRowTitle(row, t)}</span>
          {details && <span className={muted}>{details}</span>}
        </>
      )
    }
    case 'context': {
      const label = contextLabel(row, t)
      return (
        <>
          {label && <span className="shrink-0 text-[var(--color-text-secondary)]">{label}</span>}
          <span className={muted}><Highlight text={row.preview} terms={terms} /></span>
        </>
      )
    }
    case 'user': {
      const label = userLabel(row, t)
      return (
        <>
          {label && <span className="shrink-0 text-[11px] text-[var(--color-text-tertiary)]">{label}</span>}
          <span className="truncate text-[var(--color-text-primary)]"><Highlight text={row.preview} terms={terms} /></span>
        </>
      )
    }
    case 'assistant':
      return (
        <>
          {row.preview
            ? <span className="min-w-0 truncate text-[var(--color-text-primary)]"><Highlight text={row.preview} terms={terms} /></span>
            : <span className={muted}>{t(row.hasThinking && !row.toolOnly ? 'trajectory.assistant.thinkingOnly' : 'trajectory.assistant.toolOnly')}</span>}
          {hiddenTools && (
            <span className="flex min-w-0 shrink items-center gap-1.5 truncate font-mono text-[12px] text-[var(--color-text-secondary)]">
              {hiddenTools.names.slice(0, 4).map(([name, count]) => (
                <span key={name} className="shrink-0">{count > 1 ? `${name} ×${count}` : name}</span>
              ))}
              {hiddenTools.names.length > 4 && <span className="shrink-0">…</span>}
              {hiddenTools.errors > 0 && (
                <span className="shrink-0 font-sans text-[var(--color-error)]">{t('trajectory.table.errorCount', { count: hiddenTools.errors })}</span>
              )}
            </span>
          )}
        </>
      )
    case 'tool': {
      if (isOrphanTool(row)) {
        return (
          <>
            <span className={muted}>{t('trajectory.tool.callEarlier')}</span>
            {row.resultPreview && <span className={cx('min-w-0 flex-1 truncate font-mono text-[12px]', row.isError ? 'text-[var(--color-error)]' : 'text-[var(--color-text-tertiary)]')}>→ {row.resultPreview}</span>}
          </>
        )
      }
      const argument = row.inputSummary ?? row.inputPreview
      const result = row.resultOmittedBytes
        ? t('trajectory.tool.resultTooLarge', { size: formatBytes(row.resultOmittedBytes) })
        : toolHasResult(row)
          ? row.resultPreview || t('trajectory.tool.emptyResult')
          : null
      return (
        <>
          <span className="shrink-0 font-mono text-[12px] font-medium text-[var(--color-text-primary)]">{row.toolName}</span>
          {argument && (
            // Sized to its text (up to 60%), so a short command sits right next to its result.
            <span className="min-w-0 max-w-[60%] shrink truncate font-mono text-[12px] text-[var(--color-text-secondary)]" title={argument}>
              <Highlight text={argument} terms={terms} />
            </span>
          )}
          {result !== null ? (
            <span className={cx('min-w-0 flex-1 truncate font-mono text-[12px]', row.isError ? 'text-[var(--color-error)]' : 'text-[var(--color-text-tertiary)]')}>
              <span aria-hidden className="mr-1.5 font-sans">→</span>
              <Highlight text={result} terms={terms} />
            </span>
          ) : (
            <span className={muted}>{t(running ? 'trajectory.tool.running' : 'trajectory.tool.noResult')}</span>
          )}
        </>
      )
    }
    case 'compact':
      return (
        <>
          <span className="shrink-0 text-[var(--color-text-primary)]">{t('trajectory.compact.title')}</span>
          {row.preview && <span className={muted}>{row.preview}</span>}
        </>
      )
  }
}
