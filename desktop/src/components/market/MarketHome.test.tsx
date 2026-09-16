import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'

import { useSettingsStore } from '../../stores/settingsStore'
import { useMarketStore } from '../../stores/marketStore'
import { SETTINGS_TAB_ID, useTabStore } from '../../stores/tabStore'
import { useUIStore } from '../../stores/uiStore'
import type { NormalizedSkill } from '../../types/market'
import { MarketHome } from './MarketHome'

/**
 * A hand-driven `IntersectionObserver`: jsdom ships none, and the point of the
 * tests below is to decide *when* the sentinel reports itself visible.
 */
class MockIntersectionObserver implements IntersectionObserver {
  static instances: MockIntersectionObserver[] = []

  readonly root: Element | Document | null
  readonly rootMargin: string
  readonly thresholds: ReadonlyArray<number> = []
  readonly targets = new Set<Element>()
  disconnected = false

  constructor(private readonly callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
    this.root = (options?.root as Element | null) ?? null
    this.rootMargin = options?.rootMargin ?? '0px'
    MockIntersectionObserver.instances.push(this)
  }

  observe(target: Element) {
    this.targets.add(target)
  }

  unobserve(target: Element) {
    this.targets.delete(target)
  }

  disconnect() {
    this.disconnected = true
    this.targets.clear()
  }

  takeRecords(): IntersectionObserverEntry[] {
    return []
  }

  /** Reports every observed target as (not) intersecting the root. */
  emit(isIntersecting = true) {
    const entries = [...this.targets].map(
      (target) => ({ target, isIntersecting }) as IntersectionObserverEntry,
    )
    if (entries.length > 0) this.callback(entries, this)
  }

  static live() {
    return MockIntersectionObserver.instances.filter((observer) => !observer.disconnected)
  }
}

function makeSkill(overrides: Partial<NormalizedSkill> = {}): NormalizedSkill {
  return {
    id: 'clawhub:demo',
    source: 'clawhub',
    slug: 'demo',
    name: 'Demo Skill',
    summary: 'A focused demo skill',
    author: { handle: 'alice', displayName: 'Alice' },
    stats: { downloads: 1_240, stars: 18 },
    tags: ['workflow'],
    version: '1.0.0',
    securityStatus: 'benign',
    installState: 'installable',
    ...overrides,
  }
}

const originalGetBoundingClientRect = Element.prototype.getBoundingClientRect

function setViewportHeight(height: number) {
  Object.defineProperty(window, 'innerHeight', { value: height, configurable: true, writable: true })
}

/** jsdom lays nothing out, so the catalogue grid's box is stubbed. */
function stubGridBox({ top, width }: { top: number; width: number }) {
  Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
    return { ...new DOMRect(0, top, width, 0), top, width } as DOMRect
  }
}

/** Card placeholders only — the group's first child is its sr-only label. */
function skeletonCardCount(testId: string): number {
  const group = screen.getByTestId(testId).firstElementChild
  if (!group) return 0
  return [...group.children].filter((child) => child.tagName === 'DIV').length
}

beforeEach(() => {
  localStorage.clear()
  MockIntersectionObserver.instances = []
  vi.stubGlobal('IntersectionObserver', MockIntersectionObserver)
  useSettingsStore.setState({ locale: 'en' })
  useTabStore.setState({ tabs: [], activeTabId: null })
  useUIStore.setState({ pendingSettingsTab: null })
  useMarketStore.setState({
    items: [makeSkill()],
    nextCursor: null,
    sources: {
      clawhub: { status: 'ok' },
      skillhub: { status: 'cached', fetchedAt: 1_700_000_000_000 },
    },
    query: '',
    filters: { source: 'all', security: 'all', installed: 'all' },
    isLoading: false,
    isLoadingMore: false,
    error: null,
    loadMoreError: null,
    installingIds: new Set(),
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  Element.prototype.getBoundingClientRect = originalGetBoundingClientRect
  setViewportHeight(768)
})

describe('MarketHome', () => {
  it('renders the compact catalog header, command bar, sources and semantic cards', () => {
    render(<MarketHome onRequestInstall={vi.fn()} />)

    expect(screen.getByRole('heading', { name: 'Skills Market' })).toBeInTheDocument()
    expect(screen.getByTestId('market-search-input')).toBeInTheDocument()
    expect(screen.getByTestId('market-filter-bar')).toBeInTheDocument()
    expect(screen.getByTestId('market-source-status-clawhub')).toHaveTextContent('Online')
    expect(screen.getByTestId('market-source-status-skillhub')).toHaveTextContent('Cached')
    expect(screen.getByTestId('market-grid')).toContainElement(screen.getByRole('article'))
    expect(screen.getByRole('button', { name: 'Demo Skill' })).toBeInTheDocument()
    expect(screen.getByText('1 skills')).toBeInTheDocument()
  })

  it('uses a catalog-shaped skeleton while the first page is loading', () => {
    useMarketStore.setState({ items: [], isLoading: true })

    render(<MarketHome onRequestInstall={vi.fn()} />)

    // The shared skeleton carries the loading semantics on a `role="status"`
    // element and names it with an sr-only span, rather than an `aria-label`
    // on a plain grid div that a screen reader never reaches.
    expect(screen.getByTestId('market-loading')).toHaveTextContent('Loading skills…')
    expect(screen.getByRole('status')).toHaveAttribute('aria-busy', 'true')
    expect(screen.queryByTestId('market-grid')).not.toBeInTheDocument()
  })

  it('grows the first-page skeleton to cover the window instead of a fixed two rows', () => {
    // The old placeholder was six cards no matter the window. On a tall desktop
    // shell that is two rows of content above half a screen of nothing.
    setViewportHeight(1400)
    stubGridBox({ top: 300, width: 1200 })
    useMarketStore.setState({ items: [], isLoading: true })

    render(<MarketHome onRequestInstall={vi.fn()} />)

    // Five rows fit below 300px, and a 1200px container is 3 tracks wide.
    expect(skeletonCardCount('market-loading')).toBe(15)
  })

  it('opens the installed-skills browser from the header', () => {
    render(<MarketHome onRequestInstall={vi.fn()} />)

    fireEvent.click(screen.getByTestId('market-installed-entry'))

    expect(useUIStore.getState().pendingSettingsTab).toBe('skills')
    expect(useTabStore.getState().activeTabId).toBe(SETTINGS_TAB_ID)
    expect(useTabStore.getState().tabs.map((tab) => tab.type)).toEqual(['settings'])
  })
})

describe('MarketHome infinite scroll', () => {
  it('loads the next page when the sentinel reaches the viewport, with no button to press', () => {
    const loadMore = vi.fn()
    useMarketStore.setState({ nextCursor: 'cursor-2', loadMore })

    render(<MarketHome onRequestInstall={vi.fn()} />)

    expect(screen.queryByTestId('market-load-more')).not.toBeInTheDocument()
    const observer = MockIntersectionObserver.live().at(-1)
    expect(observer?.targets.has(screen.getByTestId('market-load-more-sentinel'))).toBe(true)
    // Rooted in the scroll container, and started before the reader hits bottom.
    expect(observer?.root).toBe(screen.getByTestId('market-scroll'))
    expect(observer?.rootMargin).toBe('400px')

    act(() => observer?.emit())

    expect(loadMore).toHaveBeenCalledTimes(1)
  })

  it('shows placeholder cards while the next page is in flight', () => {
    // Columns come off the real grid, which is what is on screen at this point.
    stubGridBox({ top: 0, width: 1200 })
    useMarketStore.setState({ nextCursor: 'cursor-2', isLoadingMore: true })

    render(<MarketHome onRequestInstall={vi.fn()} />)

    expect(screen.getByTestId('market-loading-more')).toHaveTextContent('Loading more…')
    // One row's worth — the page arrives before the reader scrolls past it.
    expect(skeletonCardCount('market-loading-more')).toBe(3)
    // The already-loaded cards stay put underneath the placeholder.
    expect(screen.getByTestId('market-grid')).toBeInTheDocument()
    expect(screen.queryByTestId('market-load-more')).not.toBeInTheDocument()
  })

  it('re-arms the observer once a page lands so a tall window keeps filling', () => {
    useMarketStore.setState({ nextCursor: 'cursor-2', isLoadingMore: true })
    const { rerender } = render(<MarketHome onRequestInstall={vi.fn()} />)

    // Nothing observes while a page is in flight — that would double-fetch it.
    expect(MockIntersectionObserver.live()).toHaveLength(0)

    const loadMore = vi.fn()
    act(() => useMarketStore.setState({ isLoadingMore: false, loadMore }))
    rerender(<MarketHome onRequestInstall={vi.fn()} />)

    // An observer only reports *changes*. Without re-observing, a sentinel that
    // never left the viewport fires once and the list stalls half-filled.
    const observer = MockIntersectionObserver.live().at(-1)
    act(() => observer?.emit())
    expect(loadMore).toHaveBeenCalledTimes(1)
  })

  it('stops auto-loading after a failed page and waits to be asked again', () => {
    const loadMore = vi.fn()
    useMarketStore.setState({ nextCursor: 'cursor-2', loadMoreError: 'upstream timed out', loadMore })

    render(<MarketHome onRequestInstall={vi.fn()} />)

    // Re-observing here would walk straight back into the same failure.
    expect(MockIntersectionObserver.live()).toHaveLength(0)
    expect(screen.getByRole('alert')).toHaveTextContent('Failed to load more skills')
    expect(screen.getByRole('alert')).toHaveTextContent('upstream timed out')
    // The catalogue is still readable behind the notice.
    expect(screen.getByTestId('market-grid')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(loadMore).toHaveBeenCalledTimes(1)
  })

  it('falls back to a button when the runtime has no IntersectionObserver', () => {
    vi.stubGlobal('IntersectionObserver', undefined)
    const loadMore = vi.fn()
    useMarketStore.setState({ nextCursor: 'cursor-2', loadMore })

    render(<MarketHome onRequestInstall={vi.fn()} />)

    fireEvent.click(screen.getByTestId('market-load-more'))
    expect(loadMore).toHaveBeenCalledTimes(1)
  })
})

it('keeps featured skill packages inside the existing scroll surface alongside search and installed skills', () => {
  render(<MarketHome onRequestInstall={vi.fn()} featured={<div data-testid="curated-skill-packages" />} />)
  expect(screen.getByTestId('market-scroll')).toContainElement(screen.getByTestId('curated-skill-packages'))
  expect(screen.getByTestId('market-search-input')).toBeInTheDocument()
  expect(screen.getByTestId('market-installed-entry')).toBeInTheDocument()
})
