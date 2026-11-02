import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import {
  notifyConversationFindContentChanged,
  registerConversationFindController,
  type ConversationFindController,
} from '@/components/search/conversationFindBridge'
import {
  clearFindHighlights,
  collectFindRanges,
  MAX_FIND_MATCHES,
  paintFindHighlights,
} from '@/components/search/findHighlights'

// Markup contract with the lists that use this hook:
/** Marks the list whose rows are searched from data instead of from the DOM. */
const FIND_TRANSCRIPT_ATTRIBUTE = 'data-find-transcript'
/** Carries a row's key inside that list. */
const FIND_ROW_ATTRIBUTE = 'data-find-row'
/** The page around the list, whose other text (canvas, headers) stays searchable too. */
const FIND_SCOPE_ATTRIBUTE = 'data-agent-teams-workbench'

const TRANSCRIPT_SELECTOR = `[${FIND_TRANSCRIPT_ATTRIBUTE}]`

type TranscriptFindMatch =
  | { kind: 'page'; index: number }
  | { kind: 'row'; rowIndex: number; rowKey: string; occurrence: number }

function findSurfaces(anchor: HTMLElement | null) {
  return {
    scope: anchor?.closest<HTMLElement>(`[${FIND_SCOPE_ATTRIBUTE}]`) ?? document.body,
    list: anchor?.querySelector<HTMLElement>(TRANSCRIPT_SELECTOR) ?? null,
  }
}

/**
 * Find-in-page for a progressively mounted message list.
 *
 * The find bar walks the DOM, so rows that have not been mounted yet were
 * invisible to it. While the list is on screen it registers a find controller
 * (the bridge the virtualized chat transcript uses): the rest of the page is
 * still searched as text, the list itself from its data, and moving to a match
 * mounts the pages up to that row before highlighting inside it.
 */
export function useTranscriptFind<Row>({
  rows,
  rowKey,
  rowText,
  revealThrough,
  anchorRef,
}: {
  rows: Row[]
  rowKey: (row: Row) => string
  /** What the row shows, in on-screen order, so occurrence N is the Nth one painted. */
  rowText: (row: Row) => string
  revealThrough: (index: number) => void
  /** Any element inside the list's scroller; the list and page are found from it. */
  anchorRef: RefObject<HTMLElement | null>
}) {
  const latestRef = useRef({ rows, rowKey, rowText, revealThrough })
  latestRef.current = { rows, rowKey, rowText, revealThrough }
  const matchesRef = useRef<TranscriptFindMatch[]>([])
  const controllerRef = useRef<ConversationFindController | null>(null)
  const [active, setActive] = useState<{ match: TranscriptFindMatch; query: string } | null>(null)

  useEffect(() => {
    const show = (match: TranscriptFindMatch | undefined, query: string) => {
      if (!match) {
        setActive(null)
        clearFindHighlights()
        return
      }
      if (match.kind === 'row') latestRef.current.revealThrough(match.rowIndex)
      setActive({ match, query })
    }
    let lastQuery = ''
    const controller: ConversationFindController = {
      search(query, preferredIndex = 0) {
        lastQuery = query
        const { rows: currentRows, rowKey: keyOf, rowText: textOf } = latestRef.current
        const { scope } = findSurfaces(anchorRef.current)
        const pageCount = collectFindRanges(query, [scope], TRANSCRIPT_SELECTOR).length
        const matches: TranscriptFindMatch[] = Array.from(
          { length: pageCount },
          (_, index) => ({ kind: 'page', index }),
        )
        const needle = query.toLowerCase()
        for (let rowIndex = 0; rowIndex < currentRows.length && matches.length < MAX_FIND_MATCHES; rowIndex++) {
          const row = currentRows[rowIndex]!
          const text = textOf(row).toLowerCase()
          let occurrence = 0
          let offset = text.indexOf(needle)
          while (offset !== -1 && matches.length < MAX_FIND_MATCHES) {
            matches.push({ kind: 'row', rowIndex, rowKey: keyOf(row), occurrence })
            occurrence += 1
            offset = text.indexOf(needle, offset + needle.length)
          }
        }
        matchesRef.current = matches
        show(matches[Math.min(preferredIndex, matches.length - 1)], query)
        return matches.length
      },
      navigate(index) {
        const match = matchesRef.current[index]
        if (match) show(match, lastQuery)
      },
      clear() {
        matchesRef.current = []
        setActive(null)
        clearFindHighlights()
      },
    }
    controllerRef.current = controller
    const unregister = registerConversationFindController(controller)
    return () => {
      controllerRef.current = null
      unregister()
    }
  }, [anchorRef])

  // A changed list re-runs an open search, the way the chat transcript does.
  const notifiedRowsRef = useRef(rows)
  useEffect(() => {
    if (notifiedRowsRef.current === rows) return
    notifiedRowsRef.current = rows
    const controller = controllerRef.current
    if (controller) notifyConversationFindContentChanged(controller)
  }, [rows])

  // Paint after the commit that mounted the target row.
  useLayoutEffect(() => {
    if (!active) return
    const { scope, list } = findSurfaces(anchorRef.current)
    const pageRanges = collectFindRanges(active.query, [scope], TRANSCRIPT_SELECTOR)
    const rowRanges = list ? collectFindRanges(active.query, [list]) : []
    const { match } = active
    let activeIndex = -1
    if (match.kind === 'page') {
      activeIndex = match.index < pageRanges.length ? match.index : -1
    } else {
      const rowElement = list
        ? Array.from(list.querySelectorAll<HTMLElement>(`[${FIND_ROW_ATTRIBUTE}]`))
          .find((element) => element.getAttribute(FIND_ROW_ATTRIBUTE) === match.rowKey)
        : undefined
      const inRow = rowElement
        ? rowRanges.filter((range) => rowElement.contains(range.startContainer))
        : []
      const target = inRow[Math.min(match.occurrence, inRow.length - 1)]
      if (target) activeIndex = pageRanges.length + rowRanges.indexOf(target)
      // Markdown can render the matched source differently; still bring the row up.
      else rowElement?.scrollIntoView?.({ block: 'center' })
    }
    paintFindHighlights([...pageRanges, ...rowRanges], activeIndex)
  }, [active, anchorRef])
}
