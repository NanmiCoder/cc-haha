import { beforeEach, describe, expect, it, vi } from 'vitest'

const apiMock = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
}))
const apiGetBlobMock = vi.hoisted(() => vi.fn())

vi.mock('./client', () => ({ api: apiMock, apiGetBlob: apiGetBlobMock }))

import { computerUseApi, __resetAppIconCacheForTests } from './computerUse'

describe('computerUseApi', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    apiMock.get.mockResolvedValue({})
    apiMock.post.mockResolvedValue({})
    apiMock.put.mockResolvedValue({})
    apiGetBlobMock.mockResolvedValue(new Blob(['png']))
    __resetAppIconCacheForTests()
  })

  it('preserves native runtime failure details from the status endpoint', async () => {
    const status = {
      platform: 'linux',
      engine: 'agent-desktop',
      runtime: 'agent-desktop',
      agentDesktop: { available: false, binaryPath: '/fixture/native', reason: 'accessibility_bus_unavailable' },
    }
    apiMock.get.mockResolvedValueOnce(status)
    expect(await computerUseApi.getStatus()).toEqual(status)
    expect(apiMock.post).not.toHaveBeenCalled()
  })

  it('routes every Computer Use settings request through the expected API contract', async () => {
    const patch = {
      enabled: true,
      grantFlags: { systemKeyCombos: false },
    }

    await computerUseApi.getStatus()
    await computerUseApi.runSetup()
    await computerUseApi.getInstalledApps()
    await computerUseApi.getAuthorizedApps()
    await computerUseApi.setAuthorizedApps(patch)
    await computerUseApi.openSettings('Privacy_Accessibility')
    await computerUseApi.openPermissionCard()

    expect(apiMock.get).toHaveBeenNthCalledWith(1, '/api/computer-use/status')
    expect(apiMock.get).toHaveBeenNthCalledWith(2, '/api/computer-use/apps')
    expect(apiMock.get).toHaveBeenNthCalledWith(3, '/api/computer-use/authorized-apps')
    expect(apiMock.post).toHaveBeenNthCalledWith(
      1,
      '/api/computer-use/setup',
      undefined,
      { timeout: 300_000 },
    )
    expect(apiMock.put).toHaveBeenCalledWith(
      '/api/computer-use/authorized-apps',
      patch,
    )
    expect(apiMock.post).toHaveBeenNthCalledWith(
      2,
      '/api/computer-use/open-settings',
      { pane: 'Privacy_Accessibility' },
    )
    expect(apiMock.post).toHaveBeenNthCalledWith(
      3,
      '/api/computer-use/open-permission-card',
      undefined,
      { timeout: 600_000 },
    )
  })
})

/**
 * Icons go through `apiGetBlob`, not an `<img src>`, because the packaged
 * renderer is a `file://` page whose cross-origin image loads the server
 * refuses. That makes every icon a real request, so the caching and the
 * concurrency ceiling below are what keep opening the picker from firing one
 * request — and one server-side rasterisation — per installed application.
 */
describe('computerUseApi.loadAppIcon', () => {
  beforeEach(() => {
    // This is a sibling describe, so it does not inherit the reset above and
    // has to do its own — the icon cache and the call counts both persist
    // across cases otherwise.
    vi.clearAllMocks()
    __resetAppIconCacheForTests()
    apiGetBlobMock.mockResolvedValue(new Blob(['png']))
    // jsdom has no object-URL implementation.
    globalThis.URL.createObjectURL = vi.fn(() => 'blob:stub') as never
  })

  it('requests the icon by bundle id and hands back a blob URL', async () => {
    const url = await computerUseApi.loadAppIcon('com.example.App')

    expect(url).toBe('blob:stub')
    expect(apiGetBlobMock).toHaveBeenCalledWith(
      '/api/computer-use/app-icon?bundleId=com.example.App&size=72',
    )
  })

  it('percent-encodes a bundle id so it cannot alter the query', async () => {
    await computerUseApi.loadAppIcon('weird&size=999#x')

    expect(apiGetBlobMock).toHaveBeenCalledWith(
      '/api/computer-use/app-icon?bundleId=weird%26size%3D999%23x&size=72',
    )
  })

  it('fetches once per bundle no matter how many rows ask', async () => {
    const urls = await Promise.all([
      computerUseApi.loadAppIcon('com.example.App'),
      computerUseApi.loadAppIcon('com.example.App'),
      computerUseApi.loadAppIcon('com.example.App'),
    ])
    await computerUseApi.loadAppIcon('com.example.App')

    expect(apiGetBlobMock).toHaveBeenCalledTimes(1)
    expect(new Set(urls)).toEqual(new Set(['blob:stub']))
  })

  it('resolves to null on failure and does not retry it', async () => {
    apiGetBlobMock.mockRejectedValue(new Error('404'))

    expect(await computerUseApi.loadAppIcon('com.example.NoIcon')).toBeNull()
    expect(await computerUseApi.loadAppIcon('com.example.NoIcon')).toBeNull()
    // A re-rendered list would otherwise re-request every iconless bundle.
    expect(apiGetBlobMock).toHaveBeenCalledTimes(1)
  })

  it('caps how many icon requests are in flight at once', async () => {
    let inFlight = 0
    let peak = 0
    const release: Array<() => void> = []
    apiGetBlobMock.mockImplementation(() => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      return new Promise(resolve => {
        release.push(() => {
          inFlight -= 1
          resolve(new Blob(['png']))
        })
      })
    })

    const pending = Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        computerUseApi.loadAppIcon(`com.example.App${i}`),
      ),
    )

    // Drain in waves: each release frees a slot for a queued request. Yield to
    // the macrotask queue between waves so the freed slot is actually taken
    // before the next measurement.
    for (let step = 0; step < 60; step += 1) {
      if (release.length === 0 && apiGetBlobMock.mock.calls.length >= 30) break
      release.splice(0).forEach(fn => fn())
      await new Promise(resolve => setTimeout(resolve, 0))
    }
    await pending

    expect(peak).toBeLessThanOrEqual(6)
    expect(apiGetBlobMock).toHaveBeenCalledTimes(30)
  })
})
