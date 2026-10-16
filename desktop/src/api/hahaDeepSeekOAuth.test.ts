import { beforeEach, describe, expect, it, vi } from 'vitest'

const { postMock, getMock, deleteMock } = vi.hoisted(() => ({
  postMock: vi.fn(),
  getMock: vi.fn(),
  deleteMock: vi.fn(),
}))

vi.mock('./client', () => ({
  api: { post: postMock, get: getMock, delete: deleteMock },
}))

import { hahaDeepSeekOAuthApi } from './hahaDeepSeekOAuth'

describe('hahaDeepSeekOAuthApi', () => {
  beforeEach(() => {
    postMock.mockReset()
    getMock.mockReset()
    deleteMock.mockReset()
  })

  it('starts the login with an empty body, adding the locale only when given', async () => {
    postMock.mockResolvedValue({ authorizeUrl: 'https://example.invalid/auth', state: 's' })

    await hahaDeepSeekOAuthApi.start()
    await hahaDeepSeekOAuthApi.start('zh-TW')

    expect(postMock).toHaveBeenNthCalledWith(1, '/api/haha-deepseek-oauth/start', {})
    expect(postMock).toHaveBeenNthCalledWith(2, '/api/haha-deepseek-oauth/start', { locale: 'zh-TW' })
  })

  it('reads the status and logs out on the same base path', async () => {
    getMock.mockResolvedValue({ loggedIn: false })
    deleteMock.mockResolvedValue({ ok: true })

    await hahaDeepSeekOAuthApi.status()
    await hahaDeepSeekOAuthApi.logout()

    expect(getMock).toHaveBeenCalledWith('/api/haha-deepseek-oauth')
    expect(deleteMock).toHaveBeenCalledWith('/api/haha-deepseek-oauth')
  })
})
