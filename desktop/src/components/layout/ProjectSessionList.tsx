import { useCallback, useEffect, useLayoutEffect, useRef, type ReactNode, type RefObject } from 'react'
import { Button } from '@/components/ui/Button'
import { Spinner } from '@/components/ui/Spinner'
import { useTranslation } from '@/i18n'

type Props = {
  projectKey: string
  outerScrollRef?: RefObject<HTMLDivElement | null>
  testId: string
  expanded: boolean
  hasHiddenSessions: boolean
  itemCount: number
  nextCursor?: string | null
  isLoading: boolean
  hasMore: boolean
  error?: string | null
  onExpand: () => void
  onLoadMore: () => Promise<void>
  onRelease: () => void
  children: ReactNode
}

const sidebarScrollPositions = new WeakMap<HTMLElement, number>()

/** One geometry search per sidebar scroll, regardless of project count. */
export function notifyProjectHistoryAtSidebarBottom(outer: HTMLElement) {
  const previousTop = sidebarScrollPositions.get(outer) ?? 0
  sidebarScrollPositions.set(outer, outer.scrollTop)
  if (outer.scrollTop <= previousTop) return
  const bottom = outer.getBoundingClientRect().bottom
  const lists = outer.querySelectorAll<HTMLElement>('[data-project-session-list]')
  let low = 0
  let high = lists.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (lists[middle]!.getBoundingClientRect().top < bottom) low = middle + 1
    else high = middle
  }
  const lastVisible = lists[low - 1]
  if (lastVisible && lastVisible.getBoundingClientRect().bottom <= bottom) {
    lastVisible.dispatchEvent(new Event('project-history-bottom'))
  }
}

/** Pagination belongs to the project's existing scroller, including short groups
 * which need a downward wheel/touch gesture before they have enough rows to scroll. */
export function ProjectSessionList({
  projectKey, outerScrollRef, testId, expanded, hasHiddenSessions, itemCount, nextCursor,
  isLoading, hasMore, error, onExpand, onLoadMore, onRelease, children,
}: Props) {
  const t = useTranslation()
  const listRef = useRef<HTMLDivElement>(null)
  const touchYRef = useRef<number | null>(null)
  const wasExpandedRef = useRef(expanded)
  const releaseRef = useRef(onRelease)
  releaseRef.current = onRelease
  const restoredScrollTopRef = useRef<number | null>(null)
  const rowsRef = useRef<HTMLElement[]>([])
  const anchorRef = useRef<{ id: string; offset: number } | null>(null)

  useEffect(() => () => releaseRef.current(), [projectKey])
  useEffect(() => {
    if (wasExpandedRef.current && !expanded) releaseRef.current()
    wasExpandedRef.current = expanded
  }, [expanded])

  const loadStateRef = useRef({ expanded, hasHiddenSessions, isLoading, error, hasMore, onExpand, onLoadMore, outerScrollRef })
  loadStateRef.current = { expanded, hasHiddenSessions, isLoading, error, hasMore, onExpand, onLoadMore, outerScrollRef }
  const loadAtBottom = useCallback(() => {
    const { expanded, hasHiddenSessions, isLoading, error, hasMore, onExpand, onLoadMore, outerScrollRef } = loadStateRef.current
    const list = listRef.current
    if (!list || list.clientHeight <= 0 || isLoading || error || !hasMore) return
    const outer = outerScrollRef?.current
    if (outer) {
      const viewport = outer.getBoundingClientRect()
      const bounds = list.getBoundingClientRect()
      if (bounds.bottom <= viewport.top || bounds.top >= viewport.bottom) return
    }
    if (list.scrollHeight - list.clientHeight - list.scrollTop > 48) return
    if (!expanded) {
      onExpand()
      // Expanding the six-row preview first reveals already loaded rows.
      if (hasHiddenSessions) return
    }
    void onLoadMore()
  }, [])

  useEffect(() => {
    const list = listRef.current
    if (!list || expanded || hasHiddenSessions) return
    list.addEventListener('project-history-bottom', loadAtBottom)
    return () => list.removeEventListener('project-history-bottom', loadAtBottom)
  }, [expanded, hasHiddenSessions, loadAtBottom])

  const rememberAnchor = () => {
    const list = listRef.current
    if (!list) return
    const top = list.getBoundingClientRect().top
    // Rows are in visual order; avoid reading every preceding row's layout on
    // every scroll after the user has paged through a long project.
    const rows = rowsRef.current
    let low = 0
    let high = rows.length
    while (low < high) {
      const middle = (low + high) >>> 1
      if (rows[middle]!.getBoundingClientRect().bottom <= top) low = middle + 1
      else high = middle
    }
    const row = rows[low]
    anchorRef.current = row?.dataset.sidebarSessionId
      ? { id: row.dataset.sidebarSessionId, offset: row.getBoundingClientRect().top - top }
      : null
  }

  useLayoutEffect(() => {
    const list = listRef.current
    rowsRef.current = list ? [...list.querySelectorAll<HTMLElement>('[data-sidebar-session-id]')] : []
    const anchor = anchorRef.current
    if (list && anchor && list.scrollTop > 0) {
      const row = rowsRef.current.find((candidate) => candidate.dataset.sidebarSessionId === anchor.id)
      if (row) {
        list.scrollTop += row.getBoundingClientRect().top - list.getBoundingClientRect().top - anchor.offset
        restoredScrollTopRef.current = list.scrollTop
      }
    }
    // Only fill an underfilled viewport. In creation-time order a page may
    // insert above the anchor, leaving a scrollable list at the bottom; that
    // must not drain all remaining pages without another user scroll.
    if (expanded && list && list.scrollHeight <= list.clientHeight + 1) loadAtBottom()
  }, [expanded, itemCount, nextCursor, loadAtBottom])

  return (
    <div
      ref={listRef}
      data-testid={testId}
      data-project-session-list
      className={expanded ? 'max-h-[420px] overflow-y-auto pr-1' : undefined}
      aria-busy={isLoading}
      onScroll={() => {
        const restoredTop = restoredScrollTopRef.current
        restoredScrollTopRef.current = null
        rememberAnchor()
        // Browsers emit scroll for anchor restoration too. It is not a new
        // user request for the next page.
        if (restoredTop !== null && Math.abs((listRef.current?.scrollTop ?? 0) - restoredTop) < 1) return
        loadAtBottom()
      }}
      onWheel={(event) => { if (event.deltaY > 0) loadAtBottom() }}
      onTouchStart={(event) => { touchYRef.current = event.touches[0]?.clientY ?? null }}
      onTouchMove={(event) => {
        const y = event.touches[0]?.clientY
        if (y !== undefined && touchYRef.current !== null && y < touchYRef.current) loadAtBottom()
        touchYRef.current = y ?? null
      }}
      onKeyDown={(event) => {
        if (event.target instanceof HTMLElement && event.target.closest('input, textarea, [contenteditable="true"]')) return
        if (['ArrowDown', 'PageDown', 'End'].includes(event.key)) loadAtBottom()
      }}
    >
      {children}
      {isLoading && (
        <div role="status" className="flex items-center justify-center gap-1.5 py-2 text-xs text-[var(--color-text-tertiary)]">
          <Spinner size={12} />{t('common.loading')}
        </div>
      )}
      {error && (
        <div role="alert" className="px-2 py-1 text-xs text-[var(--color-text-secondary)]">
          {t('sidebar.projectHistoryFailed')}
          <Button size="sm" variant="ghost" onClick={() => { void onLoadMore() }}>{t('common.retry')}</Button>
        </div>
      )}
    </div>
  )
}
