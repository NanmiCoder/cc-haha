import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'

const { sessionsApiMock, runtimeMocks } = vi.hoisted(() => ({
  sessionsApiMock: {
    getInspection: vi.fn(),
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
    expect(popover).toHaveTextContent('7%')
    // session-2 fixture reuses the same model string as session-1; the meter
    // percentage is the session-isolation signal under test.
    expect(popover).not.toHaveTextContent('21%')
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
    expect(trigger).toHaveClass('h-8')
    expect(trigger).not.toHaveClass('h-11')
  })

  it('grows the trigger to the 44px touch target on the browser H5 shell', () => {
    sessionsApiMock.getInspection.mockResolvedValue(baseInspection)
    runtimeMocks.isMobileViewport = true

    render(<ContextUsageIndicator sessionId="session-1" chatState="idle" messageCount={1} compact />)

    const trigger = screen.getByTestId('context-usage-indicator')
    expect(trigger).toHaveClass('h-11')
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
    expect(screen.queryByTestId('context-usage-popover')).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('context-usage-indicator'))
    const popover = await screen.findByTestId('context-usage-popover')
    expect(popover).toBeInTheDocument()
    expect(popover).toHaveTextContent('kimi-k2.6')
    expect(popover).toHaveTextContent('Messages')
    expect(document.body.contains(popover)).toBe(true)
    expect(screen.queryByTestId('context-usage-sheet')).not.toBeInTheDocument()

    fireEvent.pointerDown(document.body)
    await waitFor(() => {
      expect(screen.queryByTestId('context-usage-popover')).not.toBeInTheDocument()
    })
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
