import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { startMock, statusMock, logoutMock } = vi.hoisted(() => ({
  startMock: vi.fn(),
  statusMock: vi.fn(),
  logoutMock: vi.fn(),
}))

vi.mock('../api/hahaOpenAIOAuth', () => ({
  hahaOpenAIOAuthApi: {
    start: startMock,
    status: statusMock,
    logout: logoutMock,
  },
}))

import { useHahaOpenAIOAuthStore } from './hahaOpenAIOAuthStore'

const initialState = useHahaOpenAIOAuthStore.getState()

describe('hahaOpenAIOAuthStore', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    startMock.mockReset()
    statusMock.mockReset()
    logoutMock.mockReset()
    useHahaOpenAIOAuthStore.setState({
      ...initialState,
      status: null,
      isPolling: false,
      isLoading: false,
      error: null,
    })
  })

  afterEach(() => {
    useHahaOpenAIOAuthStore.getState().stopPolling()
    useHahaOpenAIOAuthStore.setState(initialState)
    vi.useRealTimers()
  })

  it('login returns authorizeUrl without starting polling', async () => {
    startMock.mockResolvedValue({
      authorizeUrl: 'http://localhost:3456/callback/openai?state=openai-state',
      state: 'openai-state',
    })

    const result = await useHahaOpenAIOAuthStore.getState().login()

    expect(result.authorizeUrl).toContain('/callback/openai')
    expect(useHahaOpenAIOAuthStore.getState().isPolling).toBe(false)
  })

  it('startPolling stops after OpenAI OAuth status becomes logged in', async () => {
    statusMock
      .mockResolvedValueOnce({ loggedIn: false })
      .mockResolvedValueOnce({
        loggedIn: true,
        expiresAt: Date.now() + 60_000,
        email: 'user@example.com',
        accountId: 'acct_123',
      })

    useHahaOpenAIOAuthStore.getState().startPolling()
    expect(useHahaOpenAIOAuthStore.getState().isPolling).toBe(true)

    await vi.advanceTimersByTimeAsync(2_000)
    expect(useHahaOpenAIOAuthStore.getState().isPolling).toBe(true)

    await vi.advanceTimersByTimeAsync(2_000)
    expect(useHahaOpenAIOAuthStore.getState().status).toMatchObject({
      loggedIn: true,
      email: 'user@example.com',
      accountId: 'acct_123',
    })
    expect(useHahaOpenAIOAuthStore.getState().isPolling).toBe(false)
  })

  it('logout clears status and stops polling', async () => {
    logoutMock.mockResolvedValue({ ok: true })
    useHahaOpenAIOAuthStore.setState({
      status: {
        loggedIn: true,
        expiresAt: Date.now() + 60_000,
        email: 'user@example.com',
        accountId: 'acct_123',
      },
    })
    useHahaOpenAIOAuthStore.getState().startPolling()

    await useHahaOpenAIOAuthStore.getState().logout()

    expect(logoutMock).toHaveBeenCalledTimes(1)
    expect(useHahaOpenAIOAuthStore.getState().status).toEqual({ loggedIn: false })
    expect(useHahaOpenAIOAuthStore.getState().isPolling).toBe(false)
  })

  it('preserves the signed-in account during a transient refresh error and clears the error after retry', async () => {
    const status = { loggedIn: true as const, expiresAt: 1, email: 'user@example.com', accountId: 'acct_123' }
    useHahaOpenAIOAuthStore.setState({ status })
    statusMock.mockRejectedValueOnce(new Error('Unable to verify OpenAI sign-in status right now. Please retry.'))
      .mockResolvedValueOnce({ ...status, expiresAt: 100_000 })
    await useHahaOpenAIOAuthStore.getState().fetchStatus()
    expect(useHahaOpenAIOAuthStore.getState().status).toEqual(status)
    expect(useHahaOpenAIOAuthStore.getState().error).toContain('Please retry')
    await useHahaOpenAIOAuthStore.getState().fetchStatus()
    expect(useHahaOpenAIOAuthStore.getState().status).toMatchObject({ loggedIn: true, expiresAt: 100_000 })
    expect(useHahaOpenAIOAuthStore.getState().error).toBeNull()
  })

  it('keeps first-load refresh failure unknown instead of treating it as signed out', async () => {
    statusMock.mockRejectedValueOnce(new Error('Please retry'))
    await useHahaOpenAIOAuthStore.getState().fetchStatus()
    expect(useHahaOpenAIOAuthStore.getState().status).toBeNull()
    expect(useHahaOpenAIOAuthStore.getState().error).toBe('Please retry')
  })
})
