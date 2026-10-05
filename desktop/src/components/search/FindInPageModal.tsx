import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, ChevronUp, Search, X } from 'lucide-react'
import {
  getConversationFindController,
  getConversationFindRevision,
  subscribeConversationFindController,
  type ConversationFindController,
} from './conversationFindBridge'
import { IconButton } from '@/components/ui/IconButton'
import { useTranslation } from '../../i18n'

// JS-based scoped find-in-page. We walk text nodes in the document body EXCLUDING the
// sidebar (.sidebar-panel) and this find bar ([data-find-bar]), then highlight matches
// with the CSS Custom Highlight API (Range-based, no DOM mutation → React-safe).
// Why not native webContents.findInPage: it scans the whole document incl. the <input>
// value, so the search box matches itself and steals focus/caret. Scoping sidesteps that.

const FIND_DEBOUNCE_MS = 250
const MAX_FIND_MATCHES = 1_000
const RESULTS_HL = 'cc-find-results'
const ACTIVE_HL = 'cc-find-active'
// Subtrees never searched: sidebar, tab bar, this find bar, non-content tags.
const SKIP_CLOSEST = '.sidebar-panel, [data-testid="tab-bar"], [data-find-bar], script, style, noscript'
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
      clearHighlights()
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
    clearHighlights()
  }, [])

  useEffect(() => {
    if (!open || !conversationController || !debouncedQuery.trim() || typeof MutationObserver === 'undefined') return
    let refreshTimer: number | null = null
    const observer = new MutationObserver((mutations) => {
      if (refreshTimer === null && mutations.some(mutationTouchesConversationAuxiliarySurface)) {
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
      clearHighlights()
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
    const ranges = collectRanges(q, searchRoots)
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
      paint(ranges, nextActiveIndex)
      return
    }
    if (conversationController) {
      const preferredIndex = conversationControllerRef.current === conversationController &&
          lastSearchQueryRef.current === q && rangesRef.current.length === 0
        ? activeIndexRef.current
        : 0
      clearHighlights()
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
    paint(ranges, 0)
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
    paint(ranges, next)
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
        ::highlight(${RESULTS_HL}) { background-color: var(--color-search-highlight); color: var(--color-on-search-highlight); }
        ::highlight(${ACTIVE_HL}) { background-color: var(--color-search-highlight-active); color: var(--color-on-search-highlight-active); }
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

// ---- search core (module scope, no React state) ----

/** Walk visible text nodes outside skipped subtrees; return a Range per case-insensitive match. */
function collectRanges(q: string, roots: ParentNode[]): Range[] {
  const ranges: Range[] = []
  const needle = q.toLowerCase()
  for (const root of roots) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement
        if (!parent || !node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT
        if (parent.closest(SKIP_CLOSEST)) return NodeFilter.FILTER_REJECT
        if (parent.closest('[hidden], [aria-hidden="true"], .hidden, .invisible')) return NodeFilter.FILTER_REJECT
        return NodeFilter.FILTER_ACCEPT
      },
    })
    let textNode = walker.nextNode() as Text | null
    while (textNode) {
      const text = textNode.nodeValue!.toLowerCase()
      let idx = text.indexOf(needle)
      while (idx !== -1 && ranges.length < MAX_FIND_MATCHES) {
        const range = document.createRange()
        range.setStart(textNode, idx)
        range.setEnd(textNode, idx + needle.length)
        ranges.push(range)
        idx = text.indexOf(needle, idx + needle.length)
      }
      if (ranges.length >= MAX_FIND_MATCHES) return ranges
      textNode = walker.nextNode() as Text | null
    }
  }
  return ranges
}

function elementTouchesConversationAuxiliarySurface(element: Element) {
  return element.matches(CONVERSATION_AUXILIARY_CANDIDATES) ||
    Boolean(element.closest(CONVERSATION_AUXILIARY_CANDIDATES)) ||
    Boolean(element.querySelector(CONVERSATION_AUXILIARY_CANDIDATES))
}

function mutationTouchesConversationAuxiliarySurface(mutation: MutationRecord) {
  const targetElement = mutation.target instanceof Element
    ? mutation.target
    : mutation.target.parentElement
  if (targetElement && elementTouchesConversationAuxiliarySurface(targetElement)) return true
  return [...mutation.addedNodes, ...mutation.removedNodes].some((node) => {
    const element = node instanceof Element ? node : node.parentElement
    return element ? elementTouchesConversationAuxiliarySurface(element) : false
  })
}

/** Register CSS highlights for all matches + the active one, and scroll the active into view. */
function paint(ranges: Range[], activeIndex: number) {
  const highlights = (CSS as any).highlights as Map<string, unknown> | undefined
  const HighlightCtor = (globalThis as any).Highlight
  if (highlights && HighlightCtor) {
    const results = new HighlightCtor()
    for (const r of ranges) results.add(r)
    highlights.set(RESULTS_HL, results)
    const active = ranges[activeIndex]
    if (active) {
      const activeHl = new HighlightCtor()
      activeHl.add(active)
      activeHl.priority = 1 // paint over the results highlight
      highlights.set(ACTIVE_HL, activeHl)
    } else {
      highlights.delete(ACTIVE_HL)
    }
  }
  ranges[activeIndex]?.startContainer.parentElement?.scrollIntoView({ block: 'center', behavior: 'smooth' })
}

function clearHighlights() {
  const highlights = (CSS as any).highlights as Map<string, unknown> | undefined
  highlights?.delete(RESULTS_HL)
  highlights?.delete(ACTIVE_HL)
}
