import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { ProjectSessionList, notifyProjectHistoryAtSidebarBottom } from '@/components/layout/ProjectSessionList'

vi.mock('@/i18n', () => ({ useTranslation: () => (key: string) => key }))

const onLoadMore = vi.fn().mockResolvedValue(undefined)
const onExpand = vi.fn()
const onRelease = vi.fn()
let height = 200
let contentHeight = 600
function list(overrides: Partial<React.ComponentProps<typeof ProjectSessionList>> = {}) {
  return <ProjectSessionList
    projectKey="/project" testId="list" expanded hasHiddenSessions={false}
    itemCount={20} isLoading={false} hasMore
    onLoadMore={onLoadMore} onExpand={onExpand} onRelease={onRelease}
    {...overrides}
  ><button data-sidebar-session-id="a">Conversation</button></ProjectSessionList>
}

beforeEach(() => {
  vi.clearAllMocks()
  height = 200
  contentHeight = 600
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(() => height)
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(() => contentHeight)
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('project history scrolling', () => {
  it('does not fetch on mount and fetches only near the project bottom', () => {
    render(list())
    expect(onLoadMore).not.toHaveBeenCalled()
    const scroller = screen.getByTestId('list')
    fireEvent.scroll(scroller, { target: { scrollTop: 100 } })
    expect(onLoadMore).not.toHaveBeenCalled()
    fireEvent.scroll(scroller, { target: { scrollTop: 400 } })
    expect(onLoadMore).toHaveBeenCalledTimes(1)
    expect(scroller).toHaveClass('max-h-[420px]', 'overflow-y-auto')
  })

  it('fills a short expanded group but stops once a page makes it scrollable', () => {
    contentHeight = 100
    const { rerender } = render(list({ itemCount: 1 }))
    expect(onLoadMore).toHaveBeenCalledTimes(1)
    contentHeight = 1500
    rerender(list({ itemCount: 51, nextCursor: 'next' }))
    expect(onLoadMore).toHaveBeenCalledTimes(1)
  })

  it('does not eagerly load a short unexpanded project but downward wheel can reveal its history', () => {
    contentHeight = height
    render(list({ expanded: false, itemCount: 1 }))
    expect(onLoadMore).not.toHaveBeenCalled()
    fireEvent.wheel(screen.getByTestId('list'), { deltaY: -20 })
    expect(onLoadMore).not.toHaveBeenCalled()
    fireEvent.wheel(screen.getByTestId('list'), { deltaY: 20 })
    expect(onExpand).toHaveBeenCalledTimes(1)
    expect(onLoadMore).toHaveBeenCalledTimes(1)
  })

  it('loads a short group reached by dragging the outer sidebar scrollbar', () => {
    contentHeight = height
    const outer = document.createElement('div')
    document.body.appendChild(outer)
    outer.getBoundingClientRect = () => ({ top: 0, bottom: 500 } as DOMRect)
    outer.addEventListener('scroll', () => notifyProjectHistoryAtSidebarBottom(outer))
    const { unmount } = render(list({ expanded: false, outerScrollRef: { current: outer } }), { container: outer })
    screen.getByTestId('list').getBoundingClientRect = () => ({ top: 100, bottom: 300 } as DOMRect)
    expect(onLoadMore).not.toHaveBeenCalled()
    fireEvent.scroll(outer, { target: { scrollTop: 100 } })
    expect(onLoadMore).toHaveBeenCalledTimes(1)
    unmount()
    outer.remove()
  })

  it('does not request because unrelated sidebar state changed at the bottom', () => {
    const { rerender } = render(list())
    const scroller = screen.getByTestId('list')
    scroller.scrollTop = 400
    rerender(list({ onExpand: () => {}, onLoadMore: () => onLoadMore() }))
    expect(onLoadMore).not.toHaveBeenCalled()
  })

  it('reveals already loaded preview rows before requesting older data', () => {
    contentHeight = height
    render(list({ expanded: false, hasHiddenSessions: true }))
    fireEvent.wheel(screen.getByTestId('list'), { deltaY: 20 })
    expect(onExpand).toHaveBeenCalledTimes(1)
    expect(onLoadMore).not.toHaveBeenCalled()
  })

  it.each([{ isLoading: true }, { hasMore: false }, { error: 'offline' }])(
    'does not automatically request while loading, at end, or after an error: %s',
    (state) => {
      render(list(state))
      fireEvent.scroll(screen.getByTestId('list'), { target: { scrollTop: 400 } })
      fireEvent.wheel(screen.getByTestId('list'), { deltaY: 20 })
      expect(onLoadMore).not.toHaveBeenCalled()
    },
  )

  it('does not drain pages when creation-time sorting inserts new rows above the bottom anchor', () => {
    const { rerender } = render(list())
    const scroller = screen.getByTestId('list')
    const row = screen.getByText('Conversation')
    row.getBoundingClientRect = () => ({ top: 20, bottom: 50 } as DOMRect)
    fireEvent.scroll(scroller, { target: { scrollTop: 400 } })
    expect(onLoadMore).toHaveBeenCalledTimes(1)
    row.getBoundingClientRect = () => ({ top: 420, bottom: 450 } as DOMRect)
    contentHeight = 1000
    rerender(list({ itemCount: 70, nextCursor: 'next' }))
    expect(scroller.scrollTop).toBe(800)
    fireEvent.scroll(scroller)
    expect(onLoadMore).toHaveBeenCalledTimes(1)
    fireEvent.wheel(scroller, { deltaY: 30 })
    expect(onLoadMore).toHaveBeenCalledTimes(2)
  })

  it('does not auto-fill a previously expanded project outside the sidebar viewport', () => {
    contentHeight = height
    const outer = document.createElement('div')
    outer.getBoundingClientRect = () => ({ top: 500, bottom: 900 } as DOMRect)
    render(list({ outerScrollRef: { current: outer } }))
    expect(onLoadMore).not.toHaveBeenCalled()
  })

  it('keeps rows visible on failure and retries inline', () => {
    render(list({ error: 'offline' }))
    expect(screen.getByText('Conversation')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('sidebar.projectHistoryFailed')
    fireEvent.click(screen.getByRole('button', { name: 'common.retry' }))
    expect(onLoadMore).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('supports upward finger movement and keyboard navigation for short groups', () => {
    contentHeight = height
    render(list({ expanded: false }))
    const scroller = screen.getByTestId('list')
    fireEvent.touchStart(scroller, { touches: [{ clientY: 200 }] })
    fireEvent.touchMove(scroller, { touches: [{ clientY: 150 }] })
    expect(onLoadMore).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(scroller, { key: 'End' })
    expect(onLoadMore).toHaveBeenCalledTimes(2)
  })

  it('releases pages on collapse and unmount so unseen projects stop loading', () => {
    const { rerender, unmount } = render(list())
    rerender(list({ expanded: false }))
    expect(onRelease).toHaveBeenCalledTimes(1)
    unmount()
    expect(onRelease).toHaveBeenCalledTimes(2)
  })

  it('keeps scroll position stable when appending a page', () => {
    const { rerender } = render(list())
    const scroller = screen.getByTestId('list')
    const row = screen.getByText('Conversation')
    row.getBoundingClientRect = () => ({ top: 20, bottom: 50 } as DOMRect)
    fireEvent.scroll(scroller, { target: { scrollTop: 250 } })
    row.getBoundingClientRect = () => ({ top: 54, bottom: 84 } as DOMRect)
    contentHeight = 2000
    rerender(list({ itemCount: 70, nextCursor: 'next' }))
    expect(screen.getByTestId('list')).toBe(scroller)
    expect(scroller.scrollTop).toBe(284)
    expect(onLoadMore).not.toHaveBeenCalled()
  })
})
