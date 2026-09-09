import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { startMock, statusMock, logoutMock, modelsListMock } = vi.hoisted(() => ({
  startMock: vi.fn(),
  statusMock: vi.fn(),
  logoutMock: vi.fn(),
  modelsListMock: vi.fn(),
}))

vi.mock('../api/hahaOpenAIOAuth', () => ({
  hahaOpenAIOAuthApi: {
    start: startMock,
    status: statusMock,
    logout: logoutMock,
  },
}))

vi.mock('../api/models', () => ({
  modelsApi: {
    list: modelsListMock,
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
    modelsListMock.mockReset()
    modelsListMock.mockResolvedValue({
      models: [{
        id: 'gpt-6-astra',
        name: 'GPT-6-Astra',
        description: 'Most capable model',
        context: '258400',
      }],
      provider: { id: 'openai-official', name: 'ChatGPT Official' },
    })
    useHahaOpenAIOAuthStore.setState({
      ...initialState,
      status: null,
      isPolling: false,
      isLoading: false,
      error: null,
      models: [],
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
    expect(modelsListMock).toHaveBeenCalledWith({
      providerId: 'openai-official',
      refresh: true,
    })
    expect(useHahaOpenAIOAuthStore.getState().models.map(model => model.id)).toEqual([
      'gpt-6-astra',
    ])
  })

  it('keeps OAuth login successful when model refresh fails', async () => {
    statusMock.mockResolvedValue({
      loggedIn: true,
      expiresAt: Date.now() + 60_000,
      email: 'user@example.com',
      accountId: 'acct_123',
    })
    modelsListMock.mockRejectedValue(new Error('catalog unavailable'))

    await useHahaOpenAIOAuthStore.getState().fetchStatus()

    expect(useHahaOpenAIOAuthStore.getState().status?.loggedIn).toBe(true)
    expect(useHahaOpenAIOAuthStore.getState().error).toBeNull()
    expect(useHahaOpenAIOAuthStore.getState().models).toEqual([])
  })

  it('does not restore models from a refresh that finishes after logout', async () => {
    let resolveModels: ((value: unknown) => void) | undefined
    statusMock.mockResolvedValue({
      loggedIn: true,
      expiresAt: Date.now() + 60_000,
      email: 'user@example.com',
      accountId: 'acct_123',
    })
    modelsListMock.mockReturnValue(new Promise(resolve => {
      resolveModels = resolve
    }))
    logoutMock.mockResolvedValue({ ok: true })

    const statusRequest = useHahaOpenAIOAuthStore.getState().fetchStatus()
    await Promise.resolve()
    await useHahaOpenAIOAuthStore.getState().logout()
    resolveModels?.({
      models: [{
        id: 'gpt-6-astra',
        name: 'GPT-6-Astra',
        description: 'Most capable model',
        context: '258400',
      }],
      provider: { id: 'openai-official', name: 'ChatGPT Official' },
    })
    await statusRequest

    expect(useHahaOpenAIOAuthStore.getState().status).toEqual({ loggedIn: false })
    expect(useHahaOpenAIOAuthStore.getState().models).toEqual([])
  })

  it('logout clears status, models, and stops polling', async () => {
    logoutMock.mockResolvedValue({ ok: true })
    useHahaOpenAIOAuthStore.setState({
      status: {
        loggedIn: true,
        expiresAt: Date.now() + 60_000,
        email: 'user@example.com',
        accountId: 'acct_123',
      },
      models: [{
        id: 'gpt-6-astra',
        name: 'GPT-6-Astra',
        description: 'Most capable model',
        context: '258400',
      }],
    })
    useHahaOpenAIOAuthStore.getState().startPolling()

    await useHahaOpenAIOAuthStore.getState().logout()

    expect(logoutMock).toHaveBeenCalledTimes(1)
    expect(useHahaOpenAIOAuthStore.getState().status).toEqual({ loggedIn: false })
    expect(useHahaOpenAIOAuthStore.getState().models).toEqual([])
    expect(useHahaOpenAIOAuthStore.getState().isPolling).toBe(false)
  })
})
