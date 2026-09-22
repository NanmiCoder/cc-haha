import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'

const { sessionsApiMock, runtimeMocks } = vi.hoisted(() => ({
  sessionsApiMock: {
    getInspection: vi.fn(),
    // Defaulted rather than bare: every test that opens the breakdown now starts the usage
    // poll, including the ones written before it existed that only care about the context
    // meter. `clearAllMocks` clears calls, not implementations, so this survives beforeEach.
    getSessionUsage: vi.fn(async () => ({ active: true, status: {} })),
  },
  runtimeMocks: {
    isMobileViewport: false,
    isDesktopRuntime: false,
  },
}))

vi.mock('../../hooks/useMobileViewport', () => ({
  useMobileViewport: () => runtimeMocks.isMobileViewport,
}))

vi.mock('../../lib/desktopRuntime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/desktopRuntime')>()
  return { ...actual, isDesktopRuntime: () => runtimeMocks.isDesktopRuntime }
})

vi.mock('../../api/sessions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/sessions')>()
  return {
    ...actual,
    sessionsApi: {
      ...actual.sessionsApi,
      getInspection: sessionsApiMock.getInspection,
      getSessionUsage: sessionsApiMock.getSessionUsage,
    },
  }
})

import { ContextUsageIndicator } from './ContextUsageIndicator'
import { useSettingsStore } from '../../stores/settingsStore'

const baseInspection = {
  active: true,
  status: {
    sessionId: 'session-1',
    workDir: '/workspace/project',
    cwd: '/workspace/project',
    permissionMode: 'bypassPermissions' as const,
    model: 'kimi-k2.6',
  },
  context: {
    categories: [{ name: 'Messages', tokens: 42_000, color: '#2D628F' }],
    totalTokens: 42_000,
    maxTokens: 200_000,
    rawMaxTokens: 200_000,
    percentage: 21,
    gridRows: [],
    model: 'kimi-k2.6',
    memoryFiles: [],
    mcpTools: [],
    agents: [],
  },
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

describe('ContextUsageIndicator request behavior', () => {
  const originalVisibility = document.visibilityState

  beforeEach(() => {
    vi.clearAllMocks()
    useSettingsStore.setState({ locale: 'en' })
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    })
  })

  afterEach(() => {
    cleanup()
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: originalVisibility,
    })
  })

  it('does not auto-fetch context while the document is hidden', async () => {
    sessionsApiMock.getInspection.mockResolvedValue(baseInspection)
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'hidden',
    })

    render(
      <ContextUsageIndicator
        sessionId="session-1"
        chatState="idle"
        messageCount={1}
      />,
    )

    await act(async () => {
      await Promise.resolve()
    })
    expect(sessionsApiMock.getInspection).not.toHaveBeenCalled()

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    })

    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
      await Promise.resolve()
    })

    await waitFor(() => {
      expect(sessionsApiMock.getInspection).toHaveBeenCalledTimes(1)
    })
    expect(sessionsApiMock.getInspection).toHaveBeenCalledWith('session-1', {
      includeContext: true,
      contextOnly: true,
      timeout: 30_000,
    })
  })

  it('reuses the in-flight auto inspection during session-load rerenders', async () => {
    sessionsApiMock.getInspection.mockImplementation(() => new Promise(() => {}))

    const { rerender } = render(
      <ContextUsageIndicator
        sessionId="session-1"
        chatState="thinking"
        messageCount={0}
      />,
    )

    await act(async () => {
      await Promise.resolve()
    })
    expect(sessionsApiMock.getInspection).toHaveBeenCalledTimes(1)

    rerender(
      <ContextUsageIndicator
        sessionId="session-1"
        chatState="thinking"
        messageCount={1}
      />,
    )

    await act(async () => {
      await Promise.resolve()
    })
    expect(sessionsApiMock.getInspection).toHaveBeenCalledTimes(1)
  })

  it('does not inspect context for a new session until its first turn starts', async () => {
    sessionsApiMock.getInspection.mockResolvedValue(baseInspection)

    const { rerender } = render(
      <ContextUsageIndicator
        sessionId="session-1"
        chatState="idle"
        messageCount={0}
      />,
    )

    await act(async () => {
      await Promise.resolve()
    })
    expect(sessionsApiMock.getInspection).not.toHaveBeenCalled()
    expect(screen.queryByLabelText('Context usage loading')).not.toBeInTheDocument()
    expect(screen.getByTestId('context-usage-indicator')).toHaveTextContent('--')

    rerender(
      <ContextUsageIndicator
        sessionId="session-1"
        chatState="thinking"
        messageCount={0}
      />,
    )

    await waitFor(() => {
      expect(sessionsApiMock.getInspection).toHaveBeenCalledTimes(1)
    })
  })

  it('starts a new auto inspection when the runtime identity changes', async () => {
    sessionsApiMock.getInspection.mockImplementation(() => new Promise(() => {}))

    const { rerender } = render(
      <ContextUsageIndicator
        sessionId="session-1"
        chatState="idle"
        messageCount={1}
        runtimeSelectionKey="deepseek:deepseek-chat"
      />,
    )

    await act(async () => {
      await Promise.resolve()
    })
    expect(sessionsApiMock.getInspection).toHaveBeenCalledTimes(1)

    rerender(
      <ContextUsageIndicator
        sessionId="session-1"
        chatState="idle"
        messageCount={1}
        runtimeSelectionKey="deepseek:deepseek-reasoner"
      />,
    )

    await act(async () => {
      await Promise.resolve()
    })
    expect(sessionsApiMock.getInspection).toHaveBeenCalledTimes(2)
  })

  it('loads context when a new session finishes its first turn', async () => {
    sessionsApiMock.getInspection
      .mockResolvedValueOnce({
        active: true,
        status: baseInspection.status,
        errors: { context: 'Context is not ready' },
      })
      .mockResolvedValueOnce(baseInspection)

    const { rerender } = render(
      <ContextUsageIndicator
        sessionId="session-1"
        chatState="thinking"
        messageCount={1}
      />,
    )

    await waitFor(() => {
      expect(sessionsApiMock.getInspection).toHaveBeenCalledTimes(1)
    })
    expect(screen.getByTestId('context-usage-indicator')).toHaveTextContent('--')

    rerender(
      <ContextUsageIndicator
        sessionId="session-1"
        chatState="idle"
        messageCount={2}
      />,
    )

    await waitFor(() => {
      expect(sessionsApiMock.getInspection).toHaveBeenCalledTimes(2)
      expect(screen.getByTestId('context-usage-indicator')).toHaveTextContent('21%')
    })
  })

  it('keeps the last context visible while the switched runtime is still starting', async () => {
    const nextInspection = deferred<typeof baseInspection>()
    sessionsApiMock.getInspection
      .mockResolvedValueOnce(baseInspection)
      .mockReturnValueOnce(nextInspection.promise)

    const { rerender } = render(
      <ContextUsageIndicator
        sessionId="session-1"
        chatState="idle"
        messageCount={1}
        runtimeSelectionKey="deepseek:deepseek-chat"
        fallbackModelLabel="deepseek-chat"
      />,
    )

    await waitFor(() => {
      expect(screen.getByTestId('context-usage-indicator')).toHaveTextContent('21%')
    })

    rerender(
      <ContextUsageIndicator
        sessionId="session-1"
        chatState="idle"
        messageCount={1}
        runtimeSelectionKey="deepseek:deepseek-reasoner"
        fallbackModelLabel="deepseek-reasoner"
      />,
    )

    // A runtime switch restarts the CLI. Keep the last confirmed model and
    // percentage together instead of relabeling stale usage as the new model.
    expect(screen.getByTestId('context-usage-indicator')).toHaveTextContent('21%')
    expect(screen.queryByLabelText('Context usage loading')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('context-usage-indicator'))
    expect(await screen.findByTestId('context-usage-popover')).toHaveTextContent('kimi-k2.6')
    expect(screen.queryByText('deepseek-reasoner')).not.toBeInTheDocument()

    await act(async () => {
      nextInspection.resolve({
        ...baseInspection,
        status: { ...baseInspection.status, model: 'deepseek-reasoner' },
        context: {
          ...baseInspection.context,
          model: 'deepseek-reasoner',
          percentage: 12,
        },
      })
      await nextInspection.promise
    })

    await waitFor(() => {
      expect(screen.getByTestId('context-usage-indicator')).toHaveTextContent('12%')
      expect(screen.getByTestId('context-usage-popover')).toHaveTextContent('deepseek-reasoner')
    })
  })

  it('keeps the last context until the replacement runtime signals a refresh', async () => {
    sessionsApiMock.getInspection
      .mockResolvedValueOnce(baseInspection)
      .mockResolvedValueOnce({
        active: true,
        status: { ...baseInspection.status, model: 'deepseek-reasoner' },
        errors: { context: 'CLI session stopped' },
      })
      .mockResolvedValueOnce({
        ...baseInspection,
        status: { ...baseInspection.status, model: 'deepseek-reasoner' },
        context: {
          ...baseInspection.context,
          model: 'deepseek-reasoner',
          percentage: 12,
        },
      })

    const { rerender } = render(
      <ContextUsageIndicator
        sessionId="session-1"
        chatState="idle"
        messageCount={1}
        runtimeSelectionKey="deepseek:deepseek-chat"
        fallbackModelLabel="deepseek-chat"
        refreshNonce={0}
      />,
    )
    await waitFor(() => {
      expect(screen.getByTestId('context-usage-indicator')).toHaveTextContent('21%')
    })

    rerender(
      <ContextUsageIndicator
        sessionId="session-1"
        chatState="idle"
        messageCount={1}
        runtimeSelectionKey="deepseek:deepseek-reasoner"
        fallbackModelLabel="deepseek-reasoner"
        refreshNonce={0}
      />,
    )
    await waitFor(() => {
      expect(sessionsApiMock.getInspection).toHaveBeenCalledTimes(2)
    })

    expect(screen.getByTestId('context-usage-indicator')).toHaveTextContent('21%')
    // Details only mount while open; assert the meter stayed on the previous
    // percentage before the replacement runtime's forced refresh lands.
    expect(screen.queryByText('Context usage is unavailable for this session.')).not.toBeInTheDocument()

    rerender(
      <ContextUsageIndicator
        sessionId="session-1"
        chatState="idle"
        messageCount={1}
        runtimeSelectionKey="deepseek:deepseek-reasoner"
        fallbackModelLabel="deepseek-reasoner"
        refreshNonce={1}
      />,
    )

    await waitFor(() => {
      expect(sessionsApiMock.getInspection).toHaveBeenCalledTimes(3)
      expect(screen.getByTestId('context-usage-indicator')).toHaveTextContent('12%')
    })

    fireEvent.click(screen.getByTestId('context-usage-indicator'))
    expect(await screen.findByTestId('context-usage-popover')).toHaveTextContent('deepseek-reasoner')
  })

  it('ignores a stale inspection response after the runtime identity changes', async () => {
    const first = deferred<typeof baseInspection>()
    sessionsApiMock.getInspection
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce({
        ...baseInspection,
        context: { ...baseInspection.context, percentage: 21 },
      })

    const { rerender } = render(
      <ContextUsageIndicator
        sessionId="session-1"
        chatState="idle"
        messageCount={1}
        runtimeSelectionKey="deepseek:deepseek-chat"
      />,
    )

    await act(async () => {
      await Promise.resolve()
    })

    rerender(
      <ContextUsageIndicator
        sessionId="session-1"
        chatState="idle"
        messageCount={1}
        runtimeSelectionKey="deepseek:deepseek-reasoner"
      />,
    )

    await waitFor(() => {
      expect(screen.getByTestId('context-usage-indicator')).toHaveTextContent('21%')
    })

    await act(async () => {
      first.resolve({
        ...baseInspection,
        context: { ...baseInspection.context, percentage: 90 },
      })
      await first.promise
    })

    expect(screen.getByTestId('context-usage-indicator')).toHaveTextContent('21%')
    expect(screen.getByTestId('context-usage-indicator')).not.toHaveTextContent('90%')
  })

  it('ignores a stale inspection response when identity changes while hidden', async () => {
    const first = deferred<typeof baseInspection>()
    sessionsApiMock.getInspection.mockReturnValueOnce(first.promise)

    const { rerender } = render(
      <ContextUsageIndicator
        sessionId="session-1"
        chatState="idle"
        messageCount={1}
        runtimeSelectionKey="deepseek:deepseek-chat"
      />,
    )

    await act(async () => {
      await Promise.resolve()
    })
    expect(sessionsApiMock.getInspection).toHaveBeenCalledTimes(1)

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'hidden',
    })

    rerender(
      <ContextUsageIndicator
        sessionId="session-1"
        chatState="idle"
        messageCount={1}
        runtimeSelectionKey="deepseek:deepseek-reasoner"
      />,
    )

    await act(async () => {
      first.resolve({
        ...baseInspection,
        context: { ...baseInspection.context, percentage: 90 },
      })
      await first.promise
    })

    expect(sessionsApiMock.getInspection).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('90%')).not.toBeInTheDocument()
  })

  it('does not show context retained from a different session', async () => {
    sessionsApiMock.getInspection
      .mockResolvedValueOnce(baseInspection)
      .mockResolvedValueOnce({
        ...baseInspection,
        status: { ...baseInspection.status, sessionId: 'session-2' },
        context: {
          ...baseInspection.context,
          percentage: 7,
        },
      })

    const { rerender } = render(
      <ContextUsageIndicator
        sessionId="session-1"
        chatState="idle"
        messageCount={1}
      />,
    )
    await waitFor(() => {
      expect(screen.getByTestId('context-usage-indicator')).toHaveTextContent('21%')
    })

    rerender(
      <ContextUsageIndicator
        sessionId="session-2"
        chatState="idle"
        messageCount={1}
        fallbackModelLabel="session-2-model"
      />,
    )

    // The meter must not keep the previous session's percentage while the next
    // session's inspection is still in flight / resolving.
    expect(screen.getByTestId('context-usage-indicator')).not.toHaveTextContent('21%')
    await waitFor(() => {
      expect(screen.getByTestId('context-usage-indicator')).toHaveTextContent('7%')
    })

    fireEvent.click(screen.getByTestId('context-usage-indicator'))
    const popover = await screen.findByTestId('context-usage-popover')
    // The panel headlines the *remaining* window, so session-2's 7% used reads as 93% here.
    expect(popover).toHaveTextContent('93%')
    // session-2 fixture reuses the same model string as session-1; the meter
    // percentage is the session-isolation signal under test.
    expect(popover).not.toHaveTextContent('79%')
  })

  it('forces a fresh inspection when refreshNonce bumps after a compaction (#743)', async () => {
    // First request hangs — simulates an auto refresh that started just
    // before the compact boundary and would resolve with pre-compact data.
    const first = deferred<typeof baseInspection>()
    sessionsApiMock.getInspection
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce({
        ...baseInspection,
        context: { ...baseInspection.context, totalTokens: 9_000, percentage: 5 },
      })

    const { rerender } = render(
      <ContextUsageIndicator
        sessionId="session-1"
        chatState="idle"
        messageCount={1}
        refreshNonce={0}
      />,
    )

    await act(async () => {
      await Promise.resolve()
    })
    expect(sessionsApiMock.getInspection).toHaveBeenCalledTimes(1)

    rerender(
      <ContextUsageIndicator
        sessionId="session-1"
        chatState="idle"
        messageCount={1}
        refreshNonce={1}
      />,
    )

    // The forced refresh bypasses both the auto-refresh throttle and the
    // in-flight request reuse.
    await waitFor(() => {
      expect(sessionsApiMock.getInspection).toHaveBeenCalledTimes(2)
    })
    await waitFor(() => {
      expect(screen.getByTestId('context-usage-indicator')).toHaveTextContent('5%')
    })
  })

  it('retries the forced refresh once when it fails right after compaction (#743)', async () => {
    vi.useFakeTimers()
    try {
      sessionsApiMock.getInspection
        .mockResolvedValueOnce(baseInspection)
        .mockRejectedValueOnce(new Error('Request timed out after 30s'))
        .mockResolvedValueOnce({
          ...baseInspection,
          context: { ...baseInspection.context, totalTokens: 9_000, percentage: 5 },
        })

      const { rerender } = render(
        <ContextUsageIndicator
          sessionId="session-1"
          chatState="idle"
          messageCount={1}
          refreshNonce={0}
        />,
      )
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(sessionsApiMock.getInspection).toHaveBeenCalledTimes(1)

      rerender(
        <ContextUsageIndicator
          sessionId="session-1"
          chatState="idle"
          messageCount={1}
          refreshNonce={1}
        />,
      )
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(sessionsApiMock.getInspection).toHaveBeenCalledTimes(2)

      // The CLI was still busy and the forced refresh failed — one delayed
      // retry recovers the meter instead of leaving the stale percentage.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000)
      })
      expect(sessionsApiMock.getInspection).toHaveBeenCalledTimes(3)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('ContextUsageIndicator touch target', () => {
  afterEach(() => {
    cleanup()
    runtimeMocks.isMobileViewport = false
    runtimeMocks.isDesktopRuntime = false
  })

  // `compact` is also true on the desktop composer, which narrows for the right
  // panel rather than for touch — so it cannot be the signal that grows this
  // trigger. On the phone shell it sits between two 44px buttons.
  it('keeps the desktop trigger at 32px even when the composer is compact', () => {
    sessionsApiMock.getInspection.mockResolvedValue(baseInspection)

    render(<ContextUsageIndicator sessionId="session-1" chatState="idle" messageCount={1} compact />)

    const trigger = screen.getByTestId('context-usage-indicator')
    expect(trigger).toHaveClass('h-8', 'w-8')
    expect(trigger).not.toHaveClass('h-11')
  })

  it('grows the trigger to the 44px touch target on the browser H5 shell', () => {
    sessionsApiMock.getInspection.mockResolvedValue(baseInspection)
    runtimeMocks.isMobileViewport = true

    render(<ContextUsageIndicator sessionId="session-1" chatState="idle" messageCount={1} compact />)

    const trigger = screen.getByTestId('context-usage-indicator')
    expect(trigger).toHaveClass('h-11', 'w-11')
    expect(trigger).not.toHaveClass('h-8')
  })

  it('leaves the desktop shell alone on a narrow Electron window', () => {
    sessionsApiMock.getInspection.mockResolvedValue(baseInspection)
    runtimeMocks.isMobileViewport = true
    runtimeMocks.isDesktopRuntime = true

    render(<ContextUsageIndicator sessionId="session-1" chatState="idle" messageCount={1} compact />)

    expect(screen.getByTestId('context-usage-indicator')).toHaveClass('h-8')
  })
})

describe('ContextUsageIndicator presentation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useSettingsStore.setState({ locale: 'en' })
    runtimeMocks.isMobileViewport = false
    runtimeMocks.isDesktopRuntime = false
    sessionsApiMock.getInspection.mockResolvedValue(baseInspection)
    // jsdom reports zero-size rects; give the trigger a real anchor so the
    // portalled popover can compute a non-null position on open.
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 700,
      y: 500,
      top: 500,
      left: 700,
      right: 780,
      bottom: 532,
      width: 80,
      height: 32,
      toJSON: () => ({}),
    })
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('opens a body-portalled popover on desktop click and closes on outside press', async () => {
    render(
      <ContextUsageIndicator
        sessionId="session-1"
        chatState="idle"
        messageCount={1}
      />,
    )

    await waitFor(() => {
      expect(screen.getByTestId('context-usage-indicator')).toHaveTextContent('21%')
    })
    const trigger = screen.getByTestId('context-usage-indicator')
    expect(trigger).toHaveClass('h-8', 'w-8')
    expect(trigger.querySelector('.font-mono')).not.toBeInTheDocument()
    expect(screen.queryByTestId('context-usage-popover')).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('context-usage-indicator'))
    const popover = await screen.findByTestId('context-usage-popover')
    expect(popover).toBeInTheDocument()
    expect(popover).toHaveTextContent('kimi-k2.6')
    // The category list is collapsed behind the breakdown toggle; the segmented bar is the
    // always-visible summary of the same data.
    expect(popover).not.toHaveTextContent('Messages')
    // 42,000 of 200,000 is 21% of the track, in the brand color — not an empty grey bar.
    const fill = screen.getByTestId('context-usage-fill')
    expect(fill).toHaveStyle({ width: '21%' })
    expect(fill.className).toContain('bg-[var(--color-brand)]')
    expect(screen.getByTestId('context-segmented-bar')).toHaveAttribute('aria-valuenow', '21')
    expect(document.body.contains(popover)).toBe(true)
    expect(screen.queryByTestId('context-usage-sheet')).not.toBeInTheDocument()

    fireEvent.pointerDown(document.body)
    await waitFor(() => {
      expect(screen.queryByTestId('context-usage-popover')).not.toBeInTheDocument()
    })
  })

  it('reveals the category breakdown only after expanding its toggle', async () => {
    render(
      <ContextUsageIndicator
        sessionId="session-1"
        chatState="idle"
        messageCount={1}
      />,
    )

    await waitFor(() => {
      expect(screen.getByTestId('context-usage-indicator')).toHaveTextContent('21%')
    })

    fireEvent.click(screen.getByTestId('context-usage-indicator'))
    const popover = await screen.findByTestId('context-usage-popover')
    const toggle = await screen.findByTestId('context-breakdown-toggle')
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(popover).not.toHaveTextContent('Messages')

    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(popover).toHaveTextContent('Messages')
    expect(popover).toHaveTextContent('42,000')
  })

  it('fills the meter from used tokens, not from a category color', async () => {
    sessionsApiMock.getInspection.mockResolvedValue({
      ...baseInspection,
      context: {
        ...baseInspection.context,
        // What the CLI actually sends: a terminal theme key, which is not a CSS color.
        categories: [{ name: 'Messages', tokens: 20_000, color: 'purple_FOR_SUBAGENTS_ONLY' }],
        totalTokens: 172_787,
        rawMaxTokens: 1_000_000,
        percentage: 17,
      },
    })

    render(
      <ContextUsageIndicator
        sessionId="session-1"
        chatState="idle"
        messageCount={1}
      />,
    )

    await waitFor(() => {
      expect(screen.getByTestId('context-usage-indicator')).toHaveTextContent('17%')
    })
    fireEvent.click(screen.getByTestId('context-usage-indicator'))
    await screen.findByTestId('context-usage-popover')

    const fill = screen.getByTestId('context-usage-fill')
    expect(fill).toHaveStyle({ width: '17.2787%' })
    expect(fill).not.toHaveAttribute('style', expect.stringContaining('purple_FOR_SUBAGENTS_ONLY'))
  })

  it('uses the bottom sheet when the composer is compact (Workbench / narrow column)', async () => {
    render(
      <ContextUsageIndicator
        sessionId="session-1"
        chatState="idle"
        messageCount={1}
        compact
      />,
    )

    await waitFor(() => {
      expect(screen.getByTestId('context-usage-indicator')).toHaveTextContent('21%')
    })

    fireEvent.click(screen.getByTestId('context-usage-indicator'))
    expect(await screen.findByTestId('context-usage-sheet')).toBeInTheDocument()
    expect(screen.getByTestId('context-usage-details')).toHaveAttribute('data-variant', 'sheet')
    expect(screen.queryByTestId('context-usage-popover')).not.toBeInTheDocument()
  })

  it('uses the bottom sheet on the browser H5 shell even when not compact', async () => {
    runtimeMocks.isMobileViewport = true

    render(
      <ContextUsageIndicator
        sessionId="session-1"
        chatState="idle"
        messageCount={1}
      />,
    )

    await waitFor(() => {
      expect(screen.getByTestId('context-usage-indicator')).toHaveTextContent('21%')
    })

    fireEvent.click(screen.getByTestId('context-usage-indicator'))
    expect(await screen.findByTestId('context-usage-sheet')).toBeInTheDocument()
    expect(screen.queryByTestId('context-usage-popover')).not.toBeInTheDocument()
  })
})

describe('ContextUsageIndicator session usage', () => {
  const usageInspection = (usage: Record<string, unknown>) => ({
    active: true,
    status: baseInspection.status,
    context: baseInspection.context,
    usage,
  })

  const baseUsage = {
    source: 'current_process' as const,
    totalCostUSD: 1.23,
    costDisplay: '$1.23',
    hasUnknownModelCost: false,
    totalAPIDuration: 42_000,
    totalDecodeDuration: 12_000,
    totalTtftDuration: 3_000,
    totalDuration: 300,
    totalLinesAdded: 0,
    totalLinesRemoved: 0,
    totalInputTokens: 1_000,
    totalOutputTokens: 2_400,
    totalCacheReadInputTokens: 9_000,
    totalCacheCreationInputTokens: 0,
    totalWebSearchRequests: 0,
    models: [],
  }

  beforeEach(() => {
    vi.clearAllMocks()
    runtimeMocks.isMobileViewport = false
    runtimeMocks.isDesktopRuntime = false
    useSettingsStore.setState({ locale: 'en' })
    sessionsApiMock.getInspection.mockResolvedValue(baseInspection)
    sessionsApiMock.getSessionUsage.mockResolvedValue(usageInspection(baseUsage))
  })

  afterEach(() => {
    cleanup()
  })

  it('does not poll session usage while the breakdown is closed', async () => {
    render(
      <ContextUsageIndicator sessionId="session-1" chatState="idle" messageCount={1} />,
    )

    await waitFor(() => {
      expect(screen.getByTestId('context-usage-indicator')).toHaveTextContent('21%')
    })

    // The poll is a per-open cost. Fetching for a panel nobody opened would put a CLI control
    // round-trip on every session for no visible benefit.
    expect(sessionsApiMock.getSessionUsage).not.toHaveBeenCalled()
  })

  it('renders lifetime totals once the breakdown opens', async () => {
    render(
      <ContextUsageIndicator sessionId="session-1" chatState="idle" messageCount={1} />,
    )
    await waitFor(() => {
      expect(screen.getByTestId('context-usage-indicator')).toHaveTextContent('21%')
    })

    fireEvent.click(screen.getByTestId('context-usage-indicator'))

    // Cache reads stay in the hit-rate row; they are not a separate headline.
    expect(await screen.findByTestId('session-cache-hit')).toHaveTextContent('90.0%')
    // 2400 output / 42s API time, including prefill — not the 12s decode span (200 tok/s).
    expect(screen.getByTestId('session-speed')).toHaveTextContent('57')
    expect(screen.getByTestId('session-speed')).toHaveTextContent('tok/s')
    expect(screen.getByTestId('session-cost')).toHaveTextContent('$1.23')
    expect(sessionsApiMock.getSessionUsage).toHaveBeenCalledWith('session-1', expect.anything())
  })

  it('never reports a partial cache as a perfect one', async () => {
    sessionsApiMock.getSessionUsage.mockResolvedValue(usageInspection({
      ...baseUsage,
      totalInputTokens: 4,
      totalCacheReadInputTokens: 9_996,
    }))

    render(
      <ContextUsageIndicator sessionId="session-1" chatState="idle" messageCount={1} />,
    )
    await waitFor(() => {
      expect(screen.getByTestId('context-usage-indicator')).toHaveTextContent('21%')
    })
    fireEvent.click(screen.getByTestId('context-usage-indicator'))

    expect(await screen.findByTestId('session-cache-hit')).toHaveTextContent('99.96%')
    expect(screen.getByTestId('session-cache-hit')).not.toHaveTextContent('100%')
  })

  it('withholds the speed reading when the session reported no API duration', async () => {
    // Transcript-sourced usage has no request timing. Showing a number here would mean
    // dividing by session wall clock, which includes tool execution.
    sessionsApiMock.getSessionUsage.mockResolvedValue(usageInspection({
      ...baseUsage,
      totalAPIDuration: 0,
      totalDecodeDuration: 0,
    }))

    render(
      <ContextUsageIndicator sessionId="session-1" chatState="idle" messageCount={1} />,
    )
    await waitFor(() => {
      expect(screen.getByTestId('context-usage-indicator')).toHaveTextContent('21%')
    })
    fireEvent.click(screen.getByTestId('context-usage-indicator'))

    expect(await screen.findByTestId('session-speed')).toHaveTextContent('--')
    expect(screen.getByTestId('session-speed')).not.toHaveTextContent('tok/s')
  })

  it('hides the block entirely for a session that has produced nothing', async () => {
    sessionsApiMock.getSessionUsage.mockResolvedValue(usageInspection({
      ...baseUsage,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheReadInputTokens: 0,
      totalDecodeDuration: 0,
    }))

    render(
      <ContextUsageIndicator sessionId="session-1" chatState="idle" messageCount={1} />,
    )
    await waitFor(() => {
      expect(screen.getByTestId('context-usage-indicator')).toHaveTextContent('21%')
    })
    fireEvent.click(screen.getByTestId('context-usage-indicator'))

    await screen.findByTestId('context-usage-popover')
    // An all-zero row would read as a measurement rather than an absence.
    expect(screen.queryByTestId('session-speed')).not.toBeInTheDocument()
    expect(screen.queryByTestId('session-cache-hit')).not.toBeInTheDocument()
    expect(screen.queryByTestId('session-cost')).not.toBeInTheDocument()
  })

  it('does not stack polls behind a request that has not answered yet', async () => {
    vi.useFakeTimers()
    try {
      // A stuck CLI control: the request never settles, so every tick would pile another
      // round-trip on top of it if the timer were the only gate.
      sessionsApiMock.getSessionUsage.mockImplementation(() => new Promise(() => {}))

      render(
        <ContextUsageIndicator sessionId="session-1" chatState="idle" messageCount={1} />,
      )
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
      fireEvent.click(screen.getByTestId('context-usage-indicator'))
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })

      // Three poll intervals, including the one that fires while the first request is open.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(9_000)
      })

      expect(sessionsApiMock.getSessionUsage).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('polls while open and stops when the panel closes', async () => {
    vi.useFakeTimers()
    try {
      render(
        <ContextUsageIndicator sessionId="session-1" chatState="idle" messageCount={1} />,
      )
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })

      fireEvent.click(screen.getByTestId('context-usage-indicator'))
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(sessionsApiMock.getSessionUsage).toHaveBeenCalledTimes(1)

      await act(async () => {
        await vi.advanceTimersByTimeAsync(6_000)
      })
      expect(sessionsApiMock.getSessionUsage.mock.calls.length).toBeGreaterThanOrEqual(3)

      const callsWhileOpen = sessionsApiMock.getSessionUsage.mock.calls.length
      fireEvent.click(screen.getByTestId('context-usage-indicator'))
      await act(async () => {
        await vi.advanceTimersByTimeAsync(9_000)
      })

      // Nothing keeps ticking after the popover is dismissed — the timer is owned by the
      // open state, not by the component's lifetime.
      expect(sessionsApiMock.getSessionUsage.mock.calls.length).toBe(callsWhileOpen)
    } finally {
      vi.useRealTimers()
    }
  })
})
