import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { EmptyState } from '@/components/ui/EmptyState'
import { ErrorState } from '@/components/ui/ErrorState'
import { LoadingState } from '@/components/ui/LoadingState'
import { useTrajectoryViewStore } from '../../stores/trajectoryViewStore'
import { formatDurationMs } from '../../lib/trace/formatters'
import { buildMinimap } from '../../lib/trajectory/minimap'
import {
  buildTrajectoryItems,
  computeTotals,
  computeTurnStats,
  listTurns,
  matchesQuery,
  orderTrajectoryRows,
  queryTerms,
  rowSearchText,
} from '../../lib/trajectory/viewModel'
import type { TrajectoryRow } from '../../types/trajectory'
import { TrajectoryDetailPanel } from './TrajectoryDetailPanel'
import { TrajectoryMinimap } from './TrajectoryMinimap'
import { TrajectoryTable, type TableRange, type TableScrollRequest } from './TrajectoryTable'
import { TrajectoryStopButton } from './TrajectoryStopButton'
import { TrajectoryToolbar } from './TrajectoryToolbar'
import { turnLabel } from './trajectoryLabels'
import { useTrajectoryData } from './useTrajectoryData'
import { trajectoryApi } from '../../api/trajectory'

/** Search text is derived once per row object; merged rows are new objects. */
const searchTextCache = new WeakMap<TrajectoryRow, string>()
function cachedSearchText(row: TrajectoryRow): string {
  let text = searchTextCache.get(row)
  if (text === undefined) {
    text = rowSearchText(row)
    searchTextCache.set(row, text)
  }
  return text
}

/** How many older pages a jump may pull in while looking for its row. */
const NAV_PAGE_BUDGET = 40
const SEARCH_DEBOUNCE_MS = 150
/** The ledger stays readable down to this width; below it the detail becomes a drawer. */
const LEDGER_MIN_WIDTH = 360
const DRAWER_BELOW = 760

type AgentFrame = { agentId: string; label: string; parentSelectedId: string | null }

type Props = {
  sessionId: string
  /** False while the chat tab is showing; nothing is fetched or polled then. */
  visible: boolean
  running: boolean
  activityKey: string | number
}

export default function TrajectoryView({ sessionId, visible, running, activityKey }: Props) {
  const t = useTranslation()
  const [agentStack, setAgentStack] = useState<AgentFrame[]>([])
  const agent = agentStack[agentStack.length - 1]
  const agentId = agent?.agentId
  const { state, loadOlder, reload } = useTrajectoryData({
    sessionId,
    agentId,
    visible,
    running: running && !agentId,
    activityKey,
  })

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [durationMode, setDurationMode] = useState(false)
  const [collapsedTurns, setCollapsedTurns] = useState<ReadonlySet<number>>(() => new Set())
  const [toolsHidden, setToolsHidden] = useState(false)
  const [scrollRequest, setScrollRequest] = useState<TableScrollRequest | null>(null)
  const [pendingReveal, setPendingReveal] = useState<{ rowId: string; align: TableScrollRequest['align']; offset?: number } | null>(null)
  const [range, setRange] = useState<TableRange | null>(null)
  const [splitWidth, setSplitWidth] = useState(0)
  const splitRef = useRef<HTMLDivElement>(null)
  const tableWrapRef = useRef<HTMLDivElement>(null)
  const detailWidth = useTrajectoryViewStore((s) => s.detailWidth)
  const setDetailWidth = useTrajectoryViewStore((s) => s.setDetailWidth)
  const revealInChat = useTrajectoryViewStore((s) => s.revealInChat)
  const consumeNav = useTrajectoryViewStore((s) => s.consumeNav)
  const nav = useTrajectoryViewStore((s) => (s.nav?.to === 'trajectory' && s.nav.sessionId === sessionId ? s.nav : null))

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [query])

  useLayoutEffect(() => {
    const element = splitRef.current
    if (!element) return
    setSplitWidth(element.clientWidth)
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => setSplitWidth(element.clientWidth))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const hasOlder = Boolean(state.olderCursor)
  const ordered = useMemo(
    () => orderTrajectoryRows(state.rows, state.snapshots, { hasOlder }),
    [hasOlder, state.rows, state.snapshots],
  )
  const rowsById = useMemo(() => new Map(ordered.map((row) => [row.id, row])), [ordered])
  const items = useMemo(
    () => buildTrajectoryItems(ordered, { collapsedTurns, hideTools: toolsHidden, query: debouncedQuery }, cachedSearchText),
    [collapsedTurns, debouncedQuery, ordered, toolsHidden],
  )
  const itemIndexById = useMemo(() => {
    const map = new Map<string, number>()
    items.forEach((item, index) => { if (item.type === 'row') map.set(item.row.id, index) })
    return map
  }, [items])
  const totals = useMemo(() => computeTotals(ordered), [ordered])
  const turnStats = useMemo(() => computeTurnStats(ordered), [ordered])
  const terms = useMemo(() => queryTerms(debouncedQuery), [debouncedQuery])
  const minimap = useMemo(
    () => buildMinimap(ordered, durationMode ? 'duration' : 'sequence', {
      selectedId,
      isMatch: terms.length ? (row) => matchesQuery(cachedSearchText(row), terms) : undefined,
    }),
    [durationMode, ordered, selectedId, terms],
  )

  const requestScroll = useCallback((index: number, align: TableScrollRequest['align'], offset?: number) => {
    setScrollRequest((previous) => ({ index, align, offset, nonce: (previous?.nonce ?? 0) + 1 }))
  }, [])

  // Make a row visible even when folding or the tool filter hides it, then scroll to it.
  const reveal = useCallback((rowId: string, align: TableScrollRequest['align'] = 'center') => {
    const row = rowsById.get(rowId)
    if (!row) return false
    setSelectedId(rowId)
    if (row.turn !== null && collapsedTurns.has(row.turn)) {
      setCollapsedTurns((previous) => {
        const next = new Set(previous)
        next.delete(row.turn!)
        return next
      })
    }
    if (row.kind === 'tool' && toolsHidden) setToolsHidden(false)
    setPendingReveal({ rowId, align })
    return true
  }, [collapsedTurns, rowsById, toolsHidden])

  // Finish a reveal once the row has an index in the rendered list.
  useEffect(() => {
    if (!pendingReveal) return
    const index = itemIndexById.get(pendingReveal.rowId)
    if (index === undefined) return
    setPendingReveal(null)
    requestScroll(index, pendingReveal.align, pendingReveal.offset)
  }, [itemIndexById, pendingReveal, requestScroll])

  // View options reshape the list. Keep the reader where they were: the
  // selected row if there is one, otherwise the row at the top of the view.
  const viewKey = `${debouncedQuery}\0${toolsHidden}\0${[...collapsedTurns].join(',')}`
  const lastViewKey = useRef(viewKey)
  const previousItems = useRef(items)
  useEffect(() => {
    if (lastViewKey.current === viewKey) {
      previousItems.current = items
      return
    }
    lastViewKey.current = viewKey
    const before = previousItems.current
    previousItems.current = items
    if (selectedId && itemIndexById.has(selectedId)) {
      setPendingReveal({ rowId: selectedId, align: 'center' })
      return
    }
    const anchor = range ? before[range.first] : undefined
    if (anchor?.type === 'row' && itemIndexById.has(anchor.row.id)) {
      setPendingReveal({ rowId: anchor.row.id, align: 'offset', offset: range!.firstOffset })
    } else if (items.length) {
      requestScroll(0, 'offset', 0)
    }
  }, [itemIndexById, items, range, requestScroll, selectedId, viewKey])

  // Follow the tail only when data grows (new records), never on a view change.
  const atBottom = useRef(true)
  useEffect(() => {
    if (range) atBottom.current = range.atBottom
  }, [range])
  const lastRowCount = useRef(0)
  useEffect(() => {
    const grew = ordered.length > lastRowCount.current
    const first = lastRowCount.current === 0
    lastRowCount.current = ordered.length
    if (!grew || pendingReveal) return
    if ((first || atBottom.current) && items.length) requestScroll(items.length - 1, 'end')
    // `items` is read for its length at the moment rows grow.
  }, [ordered.length, pendingReveal, requestScroll, items.length])

  // Jump requests from the chat ("view in trajectory").
  const navAttempts = useRef(0)
  useEffect(() => {
    if (!nav || nav.to !== 'trajectory') return
    if (agentStack.length) {
      setAgentStack([])
      return
    }
    if (state.status === 'loading' && state.version === 0) return
    if (reveal(nav.rowId)) {
      navAttempts.current = 0
      consumeNav(nav.nonce)
      // Keyboard users land on the list, ready to move through it.
      requestAnimationFrame(() => tableWrapRef.current?.querySelector<HTMLElement>('[role=listbox]')?.focus({ preventScroll: true }))
      return
    }
    if (state.olderCursor && !state.loadingOlder && navAttempts.current < NAV_PAGE_BUDGET) {
      navAttempts.current++
      void loadOlder()
      return
    }
    if (!state.loadingOlder) {
      navAttempts.current = 0
      consumeNav(nav.nonce)
    }
  }, [agentStack.length, consumeNav, loadOlder, nav, reveal, state.loadingOlder, state.olderCursor, state.status, state.version])

  // Coming back from a subagent: reselect the row that opened it once the main rows are in.
  const [pendingRestore, setPendingRestore] = useState<string | null>(null)
  useEffect(() => {
    if (!pendingRestore || agentId) return
    if (reveal(pendingRestore)) setPendingRestore(null)
  }, [agentId, pendingRestore, reveal])

  const selectedRow = selectedId ? rowsById.get(selectedId) ?? null : null

  const handleLoadOlder = useCallback(async () => {
    // Anchor on the first transcript row in view, at its current distance from the top.
    const anchorItem = range ? items[range.first] : items[0]
    const anchor = anchorItem?.type === 'row' ? anchorItem.row.id : null
    const offset = range?.firstOffset ?? 0
    const loaded = await loadOlder()
    if (loaded && anchor) setPendingReveal({ rowId: anchor, align: 'offset', offset })
  }, [items, loadOlder, range])

  const handleToggleTurn = useCallback((turn: number) => {
    setCollapsedTurns((previous) => {
      const next = new Set(previous)
      if (next.has(turn)) next.delete(turn)
      else next.add(turn)
      return next
    })
  }, [])

  const handleLocateInChat = useCallback(async (row: TrajectoryRow) => {
    let uuids: string[] = []
    if (row.kind !== 'tool' && row.loc.length) {
      try {
        const detail = await trajectoryApi.getRow(sessionId, row.id, row.loc)
        uuids = detail.entries.map((entry) => entry.uuid).filter((value): value is string => typeof value === 'string')
      } catch {
        // Without uuids the user row id still carries one.
      }
      if (row.id.startsWith('u:')) uuids.push(row.id.slice(2))
    }
    revealInChat(sessionId, { toolUseId: row.toolUseId, uuids })
  }, [revealInChat, sessionId])

  const viewport = useMemo(() => {
    if (!range || !items.length) return null
    const slice = items.slice(range.first, range.last + 1)
    const first = slice.find((item) => item.type === 'row')
    const last = [...slice].reverse().find((item) => item.type === 'row')
    if (first?.type !== 'row' || last?.type !== 'row') return null
    const a = minimap.positions.get(first.row.id)
    const b = minimap.positions.get(last.row.id)
    if (!a || !b) return null
    return { x: a.x, w: Math.max(0, b.x + b.w - a.x) }
  }, [items, minimap.positions, range])

  const currentTurn = useMemo(() => {
    if (!range) return null
    for (let index = range.first; index < items.length; index++) {
      const item = items[index]!
      const turn = item.type === 'row' ? item.row.turn : item.turn
      if (turn !== null && turn !== undefined) return turn
    }
    return null
  }, [items, range])

  const drawer = splitWidth > 0 && splitWidth < DRAWER_BELOW
  const maxDetailWidth = Math.max(320, splitWidth - LEDGER_MIN_WIDTH)
  const closeDetail = useCallback(() => setSelectedId(null), [])

  let body: React.ReactNode
  if (state.status === 'loading' && state.version === 0) {
    body = <LoadingState label={t('trajectory.loading')} variant="inline" size="md" className="flex-1" />
  } else if (state.status === 'error' && state.version === 0) {
    body = (
      <div className="flex flex-1 items-center justify-center p-8">
        <ErrorState title={t('trajectory.loadFailed')} detail={state.error ?? undefined} onRetry={() => void reload()} retryLabel={t('common.retry')} />
      </div>
    )
  } else if (!ordered.length) {
    body = <EmptyState title={t('trajectory.empty.title')} description={t('trajectory.empty.description')} className="flex-1" />
  } else if (!items.length && terms.length) {
    body = (
      <EmptyState
        title={t('trajectory.search.noResults')}
        description={t(hasOlder ? 'trajectory.search.noResultsPartial' : 'trajectory.search.noResultsHint')}
        action={hasOlder ? { label: t('trajectory.table.loadOlder'), onClick: () => void loadOlder() } : undefined}
        className="flex-1"
      />
    )
  } else {
    body = (
      <TrajectoryTable
        items={items}
        selectedId={selectedId}
        collapsedTurns={collapsedTurns}
        terms={terms}
        running={running && !agentId}
        onSelect={setSelectedId}
        onToggleTurn={handleToggleTurn}
        onEscape={closeDetail}
        scrollRequest={scrollRequest}
        onRangeChange={setRange}
        header={hasOlder ? (
          <button
            type="button"
            disabled={state.loadingOlder}
            onClick={() => void handleLoadOlder()}
            className="rounded-[var(--radius-sm)] px-2 text-[12px] text-[var(--color-text-tertiary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)] disabled:opacity-60"
          >
            {state.loadingOlder ? t('common.loading') : t(terms.length ? 'trajectory.table.searchLoaded' : 'trajectory.table.loadOlder')}
          </button>
        ) : null}
      />
    )
  }

  const currentStats = currentTurn !== null ? turnStats.get(currentTurn) : undefined

  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col"
      data-testid="trajectory-view"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && selectedId) {
          event.stopPropagation()
          closeDetail()
        }
      }}
    >
      <TrajectoryToolbar
        durationMode={durationMode}
        onDurationModeChange={setDurationMode}
        turnsCollapsed={collapsedTurns.size > 0}
        onTurnsCollapsedChange={(collapse) => setCollapsedTurns(collapse ? new Set(listTurns(ordered)) : new Set())}
        toolsHidden={toolsHidden}
        onToolsHiddenChange={setToolsHidden}
        query={query}
        onQueryChange={setQuery}
        matchCount={terms.length ? items.filter((item) => item.type === 'row').length : null}
        totals={totals}
        totalsPartial={hasOlder}
        agentLabel={agent?.label ?? null}
        onExitAgent={() => {
          const parentSelection = agent?.parentSelectedId ?? null
          setAgentStack([])
          setSelectedId(null)
          if (parentSelection) setPendingRestore(parentSelection)
        }}
        actions={<TrajectoryStopButton sessionId={sessionId} />}
      />
      {ordered.length > 0 && <TrajectoryMinimap model={minimap} viewport={viewport} rowsById={rowsById} onSelect={reveal} />}
      {currentTurn !== null && currentStats && !terms.length && (
        <div className="flex h-7 shrink-0 items-center gap-2 border-b border-[var(--color-border)] bg-[var(--color-surface-container-low)] px-3 text-[12px] tabular-nums text-[var(--color-text-tertiary)]" data-testid="trajectory-turn-bar">
          <button
            type="button"
            onClick={() => handleToggleTurn(currentTurn)}
            aria-expanded={!collapsedTurns.has(currentTurn)}
            className="inline-flex items-center gap-1 rounded-[var(--radius-sm)] px-1 font-medium text-[var(--color-text-primary)] hover:bg-[var(--color-surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]"
          >
            {collapsedTurns.has(currentTurn) ? <ChevronRight size={12} strokeWidth={2} aria-hidden /> : <ChevronDown size={12} strokeWidth={2} aria-hidden />}
            {turnLabel(currentTurn, t)}
          </button>
          <span>{t('trajectory.table.toolCount', { count: currentStats.tools })}</span>
          {currentStats.errors > 0 && <span className="text-[var(--color-error)]">{t('trajectory.table.errorCount', { count: currentStats.errors })}</span>}
          {currentStats.durationMs > 0 && <span>{t('trajectory.detail.approx', { value: formatDurationMs(currentStats.durationMs) })}</span>}
        </div>
      )}
      <div ref={splitRef} className="relative flex min-h-0 flex-1">
        <div ref={tableWrapRef} className="flex min-h-0 min-w-0 flex-1 flex-col">{body}</div>
        {selectedRow && (
          <TrajectoryDetailPanel
            sessionId={sessionId}
            agentId={agentId}
            row={selectedRow}
            width={detailWidth}
            maxWidth={maxDetailWidth}
            mode={drawer ? 'drawer' : 'side'}
            allowRawRequest={!agentId}
            running={running && !agentId}
            onWidthChange={setDetailWidth}
            onClose={closeDetail}
            onLocateInChat={agentId ? null : (row) => void handleLocateInChat(row)}
            onOpenAgent={(id, label) => {
              setAgentStack((previous) => [...previous, { agentId: id, label, parentSelectedId: selectedId }])
              setSelectedId(null)
            }}
            onSelectRow={(rowId) => { reveal(rowId) }}
          />
        )}
      </div>
    </div>
  )
}
