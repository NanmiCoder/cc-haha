import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'

const { sessionsApiMock } = vi.hoisted(() => ({
  sessionsApiMock: {
    getInspection: vi.fn(),
  },
}))

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
      timeout: 20_000,
    })
  })

  it('reuses the in-flight auto inspection during session-load rerenders', async () => {
    sessionsApiMock.getInspection.mockImplementation(() => new Promise(() => {}))

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
    expect(sessionsApiMock.getInspection).toHaveBeenCalledTimes(1)

    rerender(
      <ContextUsageIndicator
        sessionId="session-1"
        chatState="idle"
        messageCount={1}
      />,
    )

    await act(async () => {
      await Promise.resolve()
    })
    expect(sessionsApiMock.getInspection).toHaveBeenCalledTimes(1)
  })

  it('starts a new auto inspection when the runtime identity changes', async () => {
    sessionsApiMock.getInspection.mockImplementation(() => new Promise(() => {}))

    const { rerender } = render(
      <ContextUsageIndicator
        sessionId="session-1"
        chatState="idle"
        messageCount={0}
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
        messageCount={0}
        runtimeSelectionKey="deepseek:deepseek-reasoner"
      />,
    )

    await act(async () => {
      await Promise.resolve()
    })
    expect(sessionsApiMock.getInspection).toHaveBeenCalledTimes(2)
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
        messageCount={0}
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
        messageCount={0}
        runtimeSelectionKey="deepseek:deepseek-reasoner"
      />,
    )

    await waitFor(() => {
      expect(screen.getAllByText('21%').length).toBeGreaterThan(0)
    })

    await act(async () => {
      first.resolve({
        ...baseInspection,
        context: { ...baseInspection.context, percentage: 90 },
      })
      await first.promise
    })

    expect(screen.getAllByText('21%').length).toBeGreaterThan(0)
    expect(screen.queryByText('90%')).not.toBeInTheDocument()
  })

  it('ignores a stale inspection response when identity changes while hidden', async () => {
    const first = deferred<typeof baseInspection>()
    sessionsApiMock.getInspection.mockReturnValueOnce(first.promise)

    const { rerender } = render(
      <ContextUsageIndicator
        sessionId="session-1"
        chatState="idle"
        messageCount={0}
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
        messageCount={0}
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
})
