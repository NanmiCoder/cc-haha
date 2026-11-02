import { expect, test } from 'bun:test'
import { ApiClient, type FetchAdapter } from './client'
import { loadProfileOverview } from './profile'

function fixture(profileStatus = 200, statsStatus = 200) {
  const calls: string[] = []
  const fetch: FetchAdapter = async (url, options) => {
    calls.push(new URL(url).pathname)
    expect(options.headers.Authorization).toBe('Bearer fixture')
    expect(options.redirect).toBe('error')
    const profile = url.endsWith('/profile')
    const status = profile ? profileStatus : statsStatus
    return {
      url, status, ok: status === 200, redirected: false,
      text: async () => JSON.stringify(status !== 200 ? { error: 'unavailable' } : profile ? {
        profile: { displayName: 'Fixture', subtitle: '本地测试', avatarDataUrl: null },
      } : { stats: { totalSessions: 8 } }),
    }
  }
  return { calls, client: new ApiClient({ id: 'a', name: 'Fixture', url: 'http://127.0.0.1:3457', auth: 'lan' }, 'fixture', { fetch }) }
}

test('profile reads use the selected authenticated host and only the narrow profile endpoint', async () => {
  const { client, calls } = fixture()
  const result = await loadProfileOverview(client)
  expect(calls).toEqual(['/api/desktop-ui/preferences/profile', '/api/activity-stats'])
  expect(result.profile?.displayName).toBe('Fixture')
  expect(result.stats?.totalSessions).toBe(8)
  expect(result.profileError).toBe('')
  expect(result.statsError).toBe('')
})

test('an older host keeps usage available and explains the unavailable profile', async () => {
  const result = await loadProfileOverview(fixture(404).client)
  expect(result.profile).toBeNull()
  expect(result.profileError).toContain('更新电脑端')
  expect(result.stats?.totalSessions).toBe(8)
})

test('failed usage is not treated as zero and can be retried independently of identity', async () => {
  const failed = await loadProfileOverview(fixture(200, 500).client)
  expect(failed.stats).toBeNull()
  expect(failed.statsError).toContain('读取失败')
  expect(failed.profile?.displayName).toBe('Fixture')
  const recovered = await loadProfileOverview(fixture().client)
  expect(recovered.statsError).toBe('')
  expect(recovered.stats?.totalSessions).toBe(8)
})

test('revoked pairing asks to reconnect and a cancelled route sends no request', async () => {
  const revoked = await loadProfileOverview(fixture(401, 401).client)
  expect(revoked.statsError).toContain('重新连接')
  const { client, calls } = fixture()
  const controller = new AbortController()
  controller.abort()
  const result = await loadProfileOverview(client, controller.signal)
  expect(calls).toEqual([])
  expect(result.stats).toBeNull()
})
