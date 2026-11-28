import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from './client'
import { browserUseApi, CHROME_CONNECT_TIMEOUT_MS } from './browserUse'

vi.mock('./client', () => ({
  api: {
    get: vi.fn(),
    put: vi.fn(),
    post: vi.fn(),
  },
}))

const mockApi = api as unknown as {
  get: ReturnType<typeof vi.fn>
  put: ReturnType<typeof vi.fn>
  post: ReturnType<typeof vi.fn>
}

describe('browserUseApi', () => {
  beforeEach(() => {
    mockApi.get.mockReset()
    mockApi.put.mockReset()
    mockApi.post.mockReset()
  })

  it('fetches status and config from /api/browser-use/*', async () => {
    mockApi.get.mockResolvedValueOnce({ enabled: true })
    mockApi.get.mockResolvedValueOnce({ enabled: false, preferredTarget: 'auto' })

    await browserUseApi.getStatus()
    await browserUseApi.getConfig()

    expect(mockApi.get).toHaveBeenNthCalledWith(1, '/api/browser-use/status')
    expect(mockApi.get).toHaveBeenNthCalledWith(2, '/api/browser-use/config')
  })

  it('patches config via PUT /api/browser-use/config', async () => {
    mockApi.put.mockResolvedValueOnce({ enabled: true, preferredTarget: 'workspace' })

    await browserUseApi.updateConfig({ enabled: true, preferredTarget: 'workspace' })

    expect(mockApi.put).toHaveBeenCalledWith('/api/browser-use/config', {
      enabled: true,
      preferredTarget: 'workspace',
    })
  })

  it('calls chrome connect, launch-managed, and disconnect with extended connect timeouts', async () => {
    mockApi.post.mockResolvedValue({ ok: true })

    await browserUseApi.connectChrome({ browserId: 'chrome' })
    await browserUseApi.launchManagedChrome({ browserId: 'edge' })
    await browserUseApi.disconnectChrome()

    expect(mockApi.post).toHaveBeenNthCalledWith(
      1,
      '/api/browser-use/chrome/connect',
      { browserId: 'chrome' },
      { timeout: CHROME_CONNECT_TIMEOUT_MS },
    )
    expect(mockApi.post).toHaveBeenNthCalledWith(
      2,
      '/api/browser-use/chrome/launch-managed',
      { browserId: 'edge' },
      { timeout: CHROME_CONNECT_TIMEOUT_MS },
    )
    expect(mockApi.post).toHaveBeenNthCalledWith(3, '/api/browser-use/chrome/disconnect', {})
  })

  it('calls takeover resume and abort endpoints', async () => {
    mockApi.post.mockResolvedValue({ ok: true, resumed: true })

    await browserUseApi.resumeTakeover({ sessionId: 's1', takeoverId: 't1', note: 'done' })
    await browserUseApi.abortTakeover({ sessionId: 's1', takeoverId: 't1', reason: 'cancelled' })

    expect(mockApi.post).toHaveBeenNthCalledWith(1, '/api/browser-use/takeover/resume', {
      sessionId: 's1',
      takeoverId: 't1',
      note: 'done',
    })
    expect(mockApi.post).toHaveBeenNthCalledWith(2, '/api/browser-use/takeover/abort', {
      sessionId: 's1',
      takeoverId: 't1',
      reason: 'cancelled',
    })
  })
})
