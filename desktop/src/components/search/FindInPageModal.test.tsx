import '@testing-library/jest-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { FindInPageModal } from './FindInPageModal'
import {
  notifyConversationFindContentChanged,
  registerConversationFindController,
} from './conversationFindBridge'
import { useSettingsStore } from '../../stores/settingsStore'

describe('FindInPageModal', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    // The bar's copy is translated; assertions below spell the English strings.
    useSettingsStore.setState({ locale: 'en' })
  })

  it('keeps DOM-scoped search for non-chat pages', async () => {
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    })
    const highlights = new Map<string, { ranges: Range[]; priority?: number }>()
    class TestHighlight {
      ranges: Range[] = []
      priority?: number

      add(range: Range) {
        this.ranges.push(range)
      }
    }
    vi.stubGlobal('CSS', { highlights })
    vi.stubGlobal('Highlight', TestHighlight)

    render(
      <>
        <main>Settings page searchable value</main>
        <FindInPageModal open onClose={() => {}} />
      </>,
    )

    fireEvent.change(screen.getByPlaceholderText('Find'), { target: { value: 'searchable' } })

    await waitFor(() => expect(screen.getByText('1 / 1')).toBeTruthy())
    expect(highlights.get('cc-find-active')?.ranges).toHaveLength(1)
    expect(highlights.get('cc-find-active')?.ranges[0]?.startContainer.parentElement?.tagName).toBe('MAIN')
  })

  it('prefers visible non-chat content while a conversation controller is mounted', async () => {
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    })
    const highlights = new Map<string, { ranges: Range[]; priority?: number }>()
    class TestHighlight {
      ranges: Range[] = []

      add(range: Range) {
        this.ranges.push(range)
      }
    }
    vi.stubGlobal('CSS', { highlights })
    vi.stubGlobal('Highlight', TestHighlight)
    const search = vi.fn(() => 3)
    const unregister = registerConversationFindController({ search, navigate: vi.fn(), clear: vi.fn() })

    try {
      render(
        <>
          <aside data-testid="workbench-panel">Workspace panel unique value</aside>
          <div className="chat-scroll-area">Chat content</div>
          <FindInPageModal open onClose={() => {}} />
        </>,
      )

      fireEvent.change(screen.getByPlaceholderText('Find'), { target: { value: 'unique value' } })

      await waitFor(() => expect(screen.getByText('1 / 1')).toBeTruthy())
      expect(search).not.toHaveBeenCalled()
      expect(highlights.get('cc-find-active')?.ranges[0]?.startContainer.parentElement?.tagName).toBe('ASIDE')
    } finally {
      act(() => unregister())
    }
  })

  it('ignores hidden and header text while conversation search is active', async () => {
    vi.stubGlobal('CSS', { highlights: new Map() })
    const search = vi.fn(() => 2)
    const unregister = registerConversationFindController({ search, navigate: vi.fn(), clear: vi.fn() })

    try {
      render(
        <>
          <header>hidden-or-header needle</header>
          <div data-testid="session-terminal-panel" className="hidden">hidden-or-header needle</div>
          <div className="chat-scroll-area">Conversation</div>
          <FindInPageModal open onClose={() => {}} />
        </>,
      )

      fireEvent.change(screen.getByPlaceholderText('Find'), { target: { value: 'hidden-or-header needle' } })

      await waitFor(() => expect(search).toHaveBeenCalledWith('hidden-or-header needle', 0))
      await waitFor(() => expect(screen.getByText('1 / 2')).toBeTruthy())
    } finally {
      act(() => unregister())
    }
  })

  it('refreshes when an auxiliary surface opens and closes', async () => {
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    })
    const highlights = new Map<string, { ranges: Range[] }>()
    class TestHighlight {
      ranges: Range[] = []

      add(range: Range) {
        this.ranges.push(range)
      }
    }
    vi.stubGlobal('CSS', { highlights })
    vi.stubGlobal('Highlight', TestHighlight)
    const search = vi.fn(() => 2)
    const unregister = registerConversationFindController({ search, navigate: vi.fn(), clear: vi.fn() })
    const content = (showWorkbench: boolean) => (
      <>
        {showWorkbench ? <aside data-testid="workbench-panel">dynamic auxiliary needle</aside> : null}
        <div className="chat-scroll-area">Conversation</div>
        <FindInPageModal open onClose={() => {}} />
      </>
    )

    try {
      const view = render(content(false))
      fireEvent.change(screen.getByPlaceholderText('Find'), { target: { value: 'dynamic auxiliary needle' } })
      await waitFor(() => expect(screen.getByText('1 / 2')).toBeTruthy())

      view.rerender(content(true))
      await waitFor(() => expect(screen.getByText('1 / 1')).toBeTruthy())
      expect(highlights.get('cc-find-active')?.ranges[0]?.startContainer.parentElement?.tagName).toBe('ASIDE')

      view.rerender(content(false))
      await waitFor(() => expect(screen.getByText('1 / 2')).toBeTruthy())
      expect(search.mock.calls.length).toBeGreaterThan(1)
    } finally {
      act(() => unregister())
    }
  })

  // A list mounting N rows reports N records that all target the list. Checking
  // the list's subtree once per record made a 1,500-row mount spend 1.5s here.
  it('checks each mutated element once per batch while watching for auxiliary surfaces', async () => {
    vi.stubGlobal('CSS', { highlights: new Map() })
    const search = vi.fn(() => 1)
    const unregister = registerConversationFindController({ search, navigate: vi.fn(), clear: vi.fn() })
    try {
      render(<>
        <div data-testid="growing-list" />
        <FindInPageModal open onClose={() => {}} />
      </>)
      fireEvent.change(screen.getByPlaceholderText('Find'), { target: { value: 'needle' } })
      await waitFor(() => expect(search).toHaveBeenCalledWith('needle', 0))

      const list = screen.getByTestId('growing-list')
      const subtreeQueries = vi.spyOn(Element.prototype, 'querySelector')
      try {
        await act(async () => {
          for (let index = 0; index < 200; index += 1) list.appendChild(document.createElement('article'))
          await Promise.resolve()
        })
        expect(subtreeQueries.mock.contexts.filter((context) => context === list)).toHaveLength(1)
      } finally {
        subtreeQueries.mockRestore()
      }
    } finally {
      act(() => unregister())
    }
  })

  it('reruns an open query when the active conversation changes', async () => {
    vi.stubGlobal('CSS', { highlights: new Map() })
    const firstSearch = vi.fn(() => 2)
    const unregisterFirst = registerConversationFindController({
      search: firstSearch,
      navigate: vi.fn(),
      clear: vi.fn(),
    })
    render(<FindInPageModal open onClose={() => {}} />)

    fireEvent.change(screen.getByPlaceholderText('Find'), { target: { value: 'session needle' } })
    await waitFor(() => expect(firstSearch).toHaveBeenCalledWith('session needle', 0))
    await waitFor(() => expect(screen.getByText('1 / 2')).toBeTruthy())

    const secondSearch = vi.fn(() => 4)
    const unregisterSecond = await act(async () => {
      unregisterFirst()
      return registerConversationFindController({
        search: secondSearch,
        navigate: vi.fn(),
        clear: vi.fn(),
      })
    })

    try {
      await waitFor(() => expect(secondSearch).toHaveBeenCalledWith('session needle', 0))
      await waitFor(() => expect(screen.getByText('1 / 4')).toBeTruthy())
    } finally {
      act(() => unregisterSecond())
    }
  })

  it('does not reactivate a closed search after conversation content changes', async () => {
    const highlights = new Map<string, unknown>()
    vi.stubGlobal('CSS', { highlights })
    const search = vi.fn(() => 1)
    const controller = { search, navigate: vi.fn(), clear: vi.fn() }
    const unregister = registerConversationFindController(controller)

    try {
      const view = render(<FindInPageModal open onClose={() => {}} />)
      fireEvent.change(screen.getByPlaceholderText('Find'), { target: { value: 'closed query' } })
      await waitFor(() => expect(search).toHaveBeenCalledWith('closed query', 0))
      const callsBeforeClose = search.mock.calls.length

      view.rerender(<FindInPageModal open={false} onClose={() => {}} />)
      act(() => notifyConversationFindContentChanged(controller))
      await act(async () => Promise.resolve())

      expect(search).toHaveBeenCalledTimes(callsBeforeClose)
      expect(controller.clear).toHaveBeenCalled()
      expect(highlights.size).toBe(0)

      view.rerender(<FindInPageModal open onClose={() => {}} />)
      await waitFor(() => expect((screen.getByPlaceholderText('Find') as HTMLInputElement).value).toBe(''))
      expect(search).toHaveBeenCalledTimes(callsBeforeClose)
    } finally {
      act(() => unregister())
    }
  })
})

describe('FindInPageModal · match stepping', () => {
  function setupHighlights() {
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    })
    const highlights = new Map<string, { ranges: Range[]; priority?: number }>()
    class TestHighlight {
      ranges: Range[] = []
      priority?: number
      add(range: Range) { this.ranges.push(range) }
    }
    vi.stubGlobal('CSS', { highlights })
    vi.stubGlobal('Highlight', TestHighlight)
  }

  beforeEach(() => {
    vi.unstubAllGlobals()
    useSettingsStore.setState({ locale: 'en' })
  })

  it('names every control, none of which shows visible text', async () => {
    setupHighlights()
    render(<><main>alpha</main><FindInPageModal open onClose={() => {}} /></>)

    // These three were icon-only with hardcoded English before; the file had no
    // `useTranslation` at all.
    expect(screen.getByRole('button', { name: 'Previous match' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Next match' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Close find bar' })).toBeInTheDocument()
  })

  it('disables stepping until there is something to step through', async () => {
    setupHighlights()
    render(<><main>alpha beta alpha</main><FindInPageModal open onClose={() => {}} /></>)

    expect(screen.getByRole('button', { name: 'Next match' })).toBeDisabled()

    fireEvent.change(screen.getByPlaceholderText('Find'), { target: { value: 'alpha' } })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Next match' })).toBeEnabled())
  })

  it('steps forward and wraps at the last match', async () => {
    setupHighlights()
    render(<><main>alpha beta alpha</main><FindInPageModal open onClose={() => {}} /></>)
    fireEvent.change(screen.getByPlaceholderText('Find'), { target: { value: 'alpha' } })
    await waitFor(() => expect(screen.getByText('1 / 2')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: 'Next match' }))
    await waitFor(() => expect(screen.getByText('2 / 2')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: 'Next match' }))
    await waitFor(() => expect(screen.getByText('1 / 2')).toBeTruthy())
  })

  it('steps backward and wraps at the first match', async () => {
    setupHighlights()
    render(<><main>alpha beta alpha</main><FindInPageModal open onClose={() => {}} /></>)
    fireEvent.change(screen.getByPlaceholderText('Find'), { target: { value: 'alpha' } })
    await waitFor(() => expect(screen.getByText('1 / 2')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: 'Previous match' }))
    await waitFor(() => expect(screen.getByText('2 / 2')).toBeTruthy())
  })

  it('closes from the close button', async () => {
    setupHighlights()
    const onClose = vi.fn()
    render(<><main>alpha</main><FindInPageModal open onClose={onClose} /></>)

    fireEvent.click(screen.getByRole('button', { name: 'Close find bar' }))
    expect(onClose).toHaveBeenCalled()
  })
})
