import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, ChevronUp, Search, X } from 'lucide-react'
import {
  getConversationFindController,
  getConversationFindRevision,
  subscribeConversationFindController,
  type ConversationFindController,
} from './conversationFindBridge'
import {
  clearFindHighlights,
  collectFindRanges,
  FIND_ACTIVE_HIGHLIGHT,
  FIND_RESULTS_HIGHLIGHT,
  paintFindHighlights,
} from './findHighlights'
import { IconButton } from '@/components/ui/IconButton'
import { useTranslation } from '../../i18n'

// JS-based scoped find-in-page. We walk text nodes in the document body EXCLUDING the
// sidebar (.sidebar-panel) and this find bar ([data-find-bar]), then highlight matches
// with the CSS Custom Highlight API (Range-based, no DOM mutation → React-safe).
// Why not native webContents.findInPage: it scans the whole document incl. the <input>
// value, so the search box matches itself and steals focus/caret. Scoping sidesteps that.

const FIND_DEBOUNCE_MS = 250
const CONVERSATION_AUXILIARY_CANDIDATES = [
  '[data-testid="workbench-panel"]',
  '[data-testid="session-activity-panel"]',
  '[data-testid="session-terminal-panel"]',
].join(', ')
const CONVERSATION_AUXILIARY_SURFACES = `${CONVERSATION_AUXILIARY_CANDIDATES}:not(.hidden)`

type Props = {
  open: boolean
  onClose: () => void
}

export function FindInPageModal({ open, onClose }: Props) {
  const t = useTranslation()
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [count, setCount] = useState(0)
  const [activeIndex, setActiveIndex] = useState(0)
  const [auxiliaryRevision, setAuxiliaryRevision] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const rangesRef = useRef<Range[]>([])
  const conversationControllerRef = useRef<ConversationFindController | null>(null)
  const lastSearchQueryRef = useRef('')
  const activeIndexRef = useRef(0)
  activeIndexRef.current = activeIndex
  const conversationRevision = useSyncExternalStore(
    subscribeConversationFindController,
    getConversationFindRevision,
    getConversationFindRevision,
  )
  const conversationController = getConversationFindController()

  // Focus + reset whenever the bar opens; clear highlights when it closes.
  useEffect(() => {
    if (!open) {
      conversationControllerRef.current?.clear()
      conversationControllerRef.current = null
      clearFindHighlights()
      rangesRef.current = []
      lastSearchQueryRef.current = ''
      setQuery('')
      setDebouncedQuery('')
      setCount(0)
      setActiveIndex(0)
      return
    }
    setQuery('')
    setDebouncedQuery('')
    setCount(0)
    setActiveIndex(0)
    rangesRef.current = []
    const id = requestAnimationFrame(() => inputRef.current?.focus())
    return () => cancelAnimationFrame(id)
  }, [open])

  // Debounce the typed query.
  useEffect(() => {
    const id = setTimeout(() => setDebouncedQuery(query), FIND_DEBOUNCE_MS)
    return () => clearTimeout(id)
  }, [query])

  // Clear highlights on unmount.
  useEffect(() => () => {
    conversationControllerRef.current?.clear()
    clearFindHighlights()
  }, [])

  useEffect(() => {
    if (!open || !conversationController || !debouncedQuery.trim() || typeof MutationObserver === 'undefined') return
    let refreshTimer: number | null = null
    const observer = new MutationObserver((mutations) => {
      if (refreshTimer === null && mutationsTouchConversationAuxiliarySurface(mutations)) {
        refreshTimer = window.setTimeout(() => {
          refreshTimer = null
          setAuxiliaryRevision((current) => current + 1)
        }, 80)
      }
    })
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['class', 'hidden', 'aria-hidden'],
    })
    return () => {
      observer.disconnect()
      if (refreshTimer !== null) window.clearTimeout(refreshTimer)
    }
  }, [conversationController, debouncedQuery, open])

  // Run (or clear) the search once the query settles.
  useEffect(() => {
    if (!open) return
    const q = debouncedQuery.trim()
    if (!q) {
      conversationControllerRef.current?.clear()
      conversationControllerRef.current = null
      clearFindHighlights()
      rangesRef.current = []
      setCount(0)
      setActiveIndex(0)
      lastSearchQueryRef.current = ''
      return
    }
    // A visible workspace/activity/settings surface takes precedence over the
    // chat behind it. When no non-chat content matches, use the conversation
    // index so virtualized messages remain searchable.
    const searchRoots = conversationController
      ? Array.from(document.querySelectorAll<HTMLElement>(CONVERSATION_AUXILIARY_SURFACES))
      : [document.body]
    const ranges = collectFindRanges(q, searchRoots)
    if (ranges.length > 0) {
      const nextActiveIndex = lastSearchQueryRef.current === q && rangesRef.current.length > 0
        ? Math.min(activeIndexRef.current, ranges.length - 1)
        : 0
      conversationControllerRef.current?.clear()
      conversationControllerRef.current = null
      rangesRef.current = ranges
      setCount(ranges.length)
      setActiveIndex(nextActiveIndex)
      lastSearchQueryRef.current = q
      paintFindHighlights(ranges, nextActiveIndex)
      return
    }
    if (conversationController) {
      const preferredIndex = conversationControllerRef.current === conversationController &&
          lastSearchQueryRef.current === q && rangesRef.current.length === 0
        ? activeIndexRef.current
        : 0
      clearFindHighlights()
      rangesRef.current = []
      conversationControllerRef.current = conversationController
      const matchCount = conversationController.search(q, preferredIndex)
      const nextActiveIndex = matchCount > 0 ? Math.min(preferredIndex, matchCount - 1) : 0
      setCount(matchCount)
      setActiveIndex(nextActiveIndex)
      lastSearchQueryRef.current = q
      return
    }
    conversationControllerRef.current = null
    rangesRef.current = ranges
    setCount(ranges.length)
    setActiveIndex(0)
    lastSearchQueryRef.current = q
    paintFindHighlights(ranges, 0)
  }, [auxiliaryRevision, conversationRevision, debouncedQuery, open])

  // Next/previous — immediate, uses live state.
  function step(forward: boolean) {
    const activeConversationController = conversationController ?? conversationControllerRef.current
    if (activeConversationController && count > 0 && rangesRef.current.length === 0) {
      const nextConversationIndex = forward
        ? (activeIndex + 1) % count
        : (activeIndex - 1 + count) % count
      setActiveIndex(nextConversationIndex)
      activeConversationController.navigate(nextConversationIndex)
      return
    }
    const ranges = rangesRef.current
    if (ranges.length === 0) return
    const next = forward ? (activeIndex + 1) % ranges.length : (activeIndex - 1 + ranges.length) % ranges.length
    setActiveIndex(next)
    paintFindHighlights(ranges, next)
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault()
      step(!e.shiftKey) // Enter = next, Shift+Enter = previous
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }

  if (!open) return null

  return createPortal(
    <div className="fixed right-3 top-3 z-[var(--z-dialog)]" data-find-bar>
      {/* Highlight colors have to be real CSS declarations (the Custom Highlight
          API takes no class). They use the dedicated search-highlight pair —
          these wash over arbitrary page content, not a brand-soft panel, so
          borrowing the brand chip tokens reads wrong on tinted surfaces. */}
      <style>{`
        ::highlight(${FIND_RESULTS_HIGHLIGHT}) { background-color: var(--color-search-highlight); color: var(--color-on-search-highlight); }
        ::highlight(${FIND_ACTIVE_HIGHLIGHT}) { background-color: var(--color-search-highlight-active); color: var(--color-on-search-highlight-active); }
      `}</style>
      <div
        className="animate-overlay-in-top flex h-10 items-center gap-1 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] pl-2.5 pr-1.5 shadow-[var(--shadow-dropdown)]"
        role="dialog"
        aria-label={t('search.findInPage.title')}
      >
        <Search size={14} strokeWidth={1.75} className="shrink-0 text-[var(--color-text-tertiary)]" aria-hidden="true" />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={t('search.findInPage.placeholder')}
          className="w-52 bg-transparent text-[13px] text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-tertiary)]"
        />
        <span className="min-w-[48px] shrink-0 px-1 text-center font-mono text-[11px] tabular-nums text-[var(--color-text-tertiary)]">
          {count > 0 ? `${activeIndex + 1} / ${count}` : (debouncedQuery.trim() ? '0' : '')}
        </span>
        <IconButton
          icon={<ChevronUp size={14} strokeWidth={1.75} aria-hidden="true" />}
          label={t('search.findInPage.previousMatch')}
          size="xs"
          tone="secondary"
          disabled={count === 0}
          onClick={() => step(false)}
        />
        <IconButton
          icon={<ChevronDown size={14} strokeWidth={1.75} aria-hidden="true" />}
          label={t('search.findInPage.nextMatch')}
          size="xs"
          tone="secondary"
          disabled={count === 0}
          onClick={() => step(true)}
        />
        <IconButton
          icon={<X size={14} strokeWidth={1.75} aria-hidden="true" />}
          label={t('search.findInPage.close')}
          size="xs"
          tone="secondary"
          onClick={onClose}
        />
      </div>
    </div>,
    document.body,
  )
}

function elementTouchesConversationAuxiliarySurface(element: Element) {
  return element.matches(CONVERSATION_AUXILIARY_CANDIDATES) ||
    Boolean(element.closest(CONVERSATION_AUXILIARY_CANDIDATES)) ||
    Boolean(element.querySelector(CONVERSATION_AUXILIARY_CANDIDATES))
}

/**
 * Each element is checked once per batch. Mounting N rows into one list yields
 * N records sharing that list as target, and its subtree query made the batch
 * quadratic: a 1,500-row mount spent 1.5s here.
 */
function mutationsTouchConversationAuxiliarySurface(mutations: MutationRecord[]) {
  const checked = new Set<Element>()
  const touches = (element: Element | null) => {
    if (!element || checked.has(element)) return false
    checked.add(element)
    return elementTouchesConversationAuxiliarySurface(element)
  }
  return mutations.some((mutation) => {
    const targetElement = mutation.target instanceof Element
      ? mutation.target
      : mutation.target.parentElement
    if (touches(targetElement)) return true
    return [...mutation.addedNodes, ...mutation.removedNodes].some((node) => (
      touches(node instanceof Element ? node : node.parentElement)
    ))
  })
}
