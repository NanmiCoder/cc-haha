import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { startMock, statusMock, logoutMock } = vi.hoisted(() => ({
  startMock: vi.fn(),
  statusMock: vi.fn(),
  logoutMock: vi.fn(),
}))

vi.mock('../api/hahaGrokOAuth', () => ({
  hahaGrokOAuthApi: {
    start: startMock,
    status: statusMock,
    logout: logoutMock,
  },
}))

import { useHahaGrokOAuthStore } from './hahaGrokOAuthStore'

const initialState = useHahaGrokOAuthStore.getState()

describe('hahaGrokOAuthStore', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    startMock.mockReset()
    statusMock.mockReset()
    logoutMock.mockReset()
    useHahaGrokOAuthStore.setState({
      ...initialState,
      status: null,
      isPolling: false,
      isLoading: false,
      error: null,
    })
  })

  afterEach(() => {
    useHahaGrokOAuthStore.getState().stopPolling()
    useHahaGrokOAuthStore.setState(initialState)
    vi.useRealTimers()
  })

  it('returns the authorization URL without polling before the browser opens', async () => {
    startMock.mockResolvedValue({
      authorizeUrl: 'https://accounts.x.ai/oauth/authorize?state=grok-state',
      state: 'grok-state',
    })

    const result = await useHahaGrokOAuthStore.getState().login()

    expect(result.authorizeUrl).toContain('state=grok-state')
    expect(useHahaGrokOAuthStore.getState().isPolling).toBe(false)
  })

  it('stops polling after Grok OAuth becomes logged in', async () => {
    statusMock
      .mockResolvedValueOnce({ loggedIn: false })
      .mockResolvedValueOnce({
        loggedIn: true,
        expiresAt: Date.now() + 60_000,
        email: 'grok@example.com',
      })

    useHahaGrokOAuthStore.getState().startPolling()
    await vi.advanceTimersByTimeAsync(4_000)

    expect(useHahaGrokOAuthStore.getState().status).toMatchObject({
      loggedIn: true,
      email: 'grok@example.com',
    })
    expect(useHahaGrokOAuthStore.getState().isPolling).toBe(false)
  })
})
