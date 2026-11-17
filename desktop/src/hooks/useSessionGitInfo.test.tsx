import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionGitInfo } from '../api/sessions'

const apiMocks = vi.hoisted(() => {
  const invalidationListeners = new Map<string, Set<() => void>>()
  return {
    getGitInfo: vi.fn(),
    invalidateGitInfo: vi.fn((sessionId: string) => {
      const listeners = invalidationListeners.get(sessionId)
      if (!listeners) return
      for (const onInvalidate of [...listeners]) {
        onInvalidate()
      }
    }),
    subscribeGitInfo: vi.fn((
      sessionId: string,
      _listener: (info: SessionGitInfo) => void,
      options?: { onInvalidate?: () => void },
    ) => {
      const onInvalidate = options?.onInvalidate
      if (!onInvalidate) return () => {}
      let set = invalidationListeners.get(sessionId)
      if (!set) {
        set = new Set()
        invalidationListeners.set(sessionId, set)
      }
      set.add(onInvalidate)
      return () => {
        const current = invalidationListeners.get(sessionId)
        if (!current) return
        current.delete(onInvalidate)
        if (current.size === 0) {
          invalidationListeners.delete(sessionId)
        }
      }
    }),
    clearInvalidationListeners: () => invalidationListeners.clear(),
  }
})

vi.mock('../api/sessions', () => ({
  sessionsApi: {
    getGitInfo: apiMocks.getGitInfo,
    invalidateGitInfo: apiMocks.invalidateGitInfo,
    subscribeGitInfo: apiMocks.subscribeGitInfo,
  },
}))

import { sessionsApi } from '../api/sessions'
import { useSessionGitInfo } from './useSessionGitInfo'

describe('useSessionGitInfo', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    apiMocks.clearInvalidationListeners()
  })

  afterEach(() => {
    cleanup()
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    })
  })

  it('returns null without fetching when disabled and resolves null from refreshGitInfo', async () => {
    const { result } = renderHook(() => useSessionGitInfo({
      sessionId: 'disabled-session',
      enabled: false,
    }))

    expect(result.current.gitInfo).toBeNull()
    expect(apiMocks.getGitInfo).not.toHaveBeenCalled()
    expect(await result.current.refreshGitInfo()).toBeNull()
  })

  it('coalesces concurrent mount and return refreshes across subscribers and ignores hidden visibility events', async () => {
    let branch = 'master'
    apiMocks.getGitInfo.mockImplementation(async () => ({
      branch,
      repoName: 'repo',
      workDir: '/repo',
      changedFiles: 0,
      worktree: null,
    }))

    const header = renderHook(() => useSessionGitInfo({
      sessionId: 'shared-session',
      workDir: '/repo',
      visible: true,
    }))
    const composer = renderHook(() => useSessionGitInfo({
      sessionId: 'shared-session',
      workDir: '/repo',
      visible: true,
    }))

    await waitFor(() => {
      expect(header.result.current.gitInfo?.branch).toBe('master')
      expect(composer.result.current.gitInfo?.branch).toBe('master')
    })
    expect(apiMocks.getGitInfo).toHaveBeenCalledTimes(1)

    // Hidden document skips refresh on visibilitychange.
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'hidden',
    })
    branch = 'ignored-while-hidden'
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(apiMocks.getGitInfo).toHaveBeenCalledTimes(1)

    // Visible focus refreshes once and updates both subscribers; immediate second focus is throttled.
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    })
    branch = 'dev_xxxx'
    act(() => {
      window.dispatchEvent(new Event('focus'))
      window.dispatchEvent(new Event('focus'))
    })
    await waitFor(() => {
      expect(header.result.current.gitInfo?.branch).toBe('dev_xxxx')
      expect(composer.result.current.gitInfo?.branch).toBe('dev_xxxx')
    })
    expect(apiMocks.getGitInfo).toHaveBeenCalledTimes(2)
  })

  it('fetches once when mounting or switching to an idle non-empty session and refreshes only after turn state changes', async () => {
    let branchBySession: Record<string, string> = {
      'session-a': 'master',
      'session-b': 'feature/tab-b',
    }
    apiMocks.getGitInfo.mockImplementation(async (sessionId: string) => ({
      branch: branchBySession[sessionId] ?? 'main',
      repoName: 'repo',
      workDir: '/repo',
      changedFiles: 0,
      worktree: null,
    }))

    const { result, rerender } = renderHook(
      (props: { sessionId: string; chatState: string; messageCount: number; secondaryRefreshKey: number }) =>
        useSessionGitInfo({
          sessionId: props.sessionId,
          workDir: '/repo',
          chatState: props.chatState,
          messageCount: props.messageCount,
          secondaryRefreshKey: props.secondaryRefreshKey,
        }),
      {
        initialProps: {
          sessionId: 'session-a',
          chatState: 'idle',
          messageCount: 4,
          secondaryRefreshKey: 6,
        },
      },
    )

    await waitFor(() => {
      expect(result.current.gitInfo?.branch).toBe('master')
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(apiMocks.getGitInfo).toHaveBeenCalledTimes(1)

    // Switching to another idle non-empty session also fetches only once.
    rerender({
      sessionId: 'session-b',
      chatState: 'idle',
      messageCount: 2,
      secondaryRefreshKey: 3,
    })
    await waitFor(() => {
      expect(result.current.gitInfo?.branch).toBe('feature/tab-b')
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(apiMocks.getGitInfo).toHaveBeenCalledTimes(2)

    // Completing a turn (`thinking` -> `idle`) triggers a single live refresh.
    branchBySession = { ...branchBySession, 'session-b': 'dev_xxxx' }
    rerender({
      sessionId: 'session-b',
      chatState: 'thinking',
      messageCount: 3,
      secondaryRefreshKey: 3,
    })
    rerender({
      sessionId: 'session-b',
      chatState: 'idle',
      messageCount: 3,
      secondaryRefreshKey: 3,
    })
    await waitFor(() => {
      expect(result.current.gitInfo?.branch).toBe('dev_xxxx')
    })
    expect(apiMocks.getGitInfo).toHaveBeenCalledTimes(3)
  })

  it('drops an in-flight response when sessionsApi.invalidateGitInfo is called externally', async () => {
    let resolveStale!: (info: SessionGitInfo) => void
    const stalePromise = new Promise<SessionGitInfo>((resolve) => {
      resolveStale = resolve
    })
    apiMocks.getGitInfo.mockReturnValueOnce(stalePromise)

    const { result } = renderHook(() => useSessionGitInfo({
      sessionId: 'invalidated-session',
      workDir: '/repo',
    }))

    await waitFor(() => {
      expect(apiMocks.getGitInfo).toHaveBeenCalledTimes(1)
    })

    // External invalidation (e.g. sessionStore.updateSessionWorkDir) supersedes the in-flight request.
    act(() => {
      sessionsApi.invalidateGitInfo('invalidated-session')
    })

    await act(async () => {
      resolveStale({
        branch: 'stale-master',
        repoName: 'repo',
        workDir: '/repo',
        changedFiles: 0,
        worktree: null,
      })
      await stalePromise
    })

    expect(result.current.gitInfo).toBeNull()

    // A subsequent refresh is not coalesced onto the invalidated request and publishes fresh data.
    apiMocks.getGitInfo.mockResolvedValueOnce({
      branch: 'dev_xxxx',
      repoName: 'repo',
      workDir: '/repo',
      changedFiles: 0,
      worktree: null,
    })
    await act(async () => {
      await result.current.refreshGitInfo()
    })
    expect(result.current.gitInfo?.branch).toBe('dev_xxxx')
  })

  it('keeps the previous snapshot when a background refresh fails', async () => {
    apiMocks.getGitInfo.mockResolvedValueOnce({
      branch: 'master',
      repoName: 'repo',
      workDir: '/repo',
      changedFiles: 0,
      worktree: null,
    })

    const { result } = renderHook(() => useSessionGitInfo({
      sessionId: 'resilient-session',
      workDir: '/repo',
    }))

    await waitFor(() => {
      expect(result.current.gitInfo?.branch).toBe('master')
    })

    apiMocks.getGitInfo.mockRejectedValueOnce(new Error('git failed'))
    let refreshed: unknown = 'unset'
    await act(async () => {
      refreshed = await result.current.refreshGitInfo()
    })
    expect(refreshed).toBeNull()
    expect(result.current.gitInfo?.branch).toBe('master')
  })
})
