import { afterEach, expect, it, vi } from 'vitest'
import { fetchServerImageBlobUrl } from '../../../lib/authedImage'
import { loadShareAssets } from './render'

vi.mock('../../../lib/authedImage', () => ({ fetchServerImageBlobUrl: vi.fn() }))

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

it('uses the connected profile avatar in shared images without an authenticated request to a data URL', async () => {
  const loaded: string[] = []
  class FixtureImage {
    onload: (() => void) | null = null
    set src(value: string) {
      loaded.push(value)
      queueMicrotask(() => this.onload?.())
    }
  }
  vi.stubGlobal('Image', FixtureImage)
  const avatarUrl = 'data:image/png;base64,cGljdHVyZQ=='
  const assets = await loadShareAssets(avatarUrl)
  expect(loaded).toEqual(['/app-icon.png', avatarUrl])
  expect(fetchServerImageBlobUrl).not.toHaveBeenCalled()
  expect(assets.avatar?.zoom).toBe(1)
  assets.dispose()
})
