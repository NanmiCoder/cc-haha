import { expect, test } from 'bun:test'
import { loadProfileOverview } from '../src/core/profile'
import { profileModel } from '../src/ui/profile/profileModel'
import { ApiClient } from '../src/core/client'
import { FIXTURE_TOKEN, startFixtureServer } from './fixture-server'

test('personal page loads the selected computer profile and consistent usage through HTTP', async () => {
  const fixture = startFixtureServer({ port: 0, quiet: true, hostName: 'Profile fixture' })
  try {
    const client = new ApiClient({ id: 'fixture', name: 'Profile fixture', url: `http://127.0.0.1:${fixture.server.port}`, auth: 'lan' }, FIXTURE_TOKEN)
    const overview = await loadProfileOverview(client)
    expect(overview.profile?.subtitle).toBe('Profile fixture 的使用记录')
    expect(overview.statsError).toBe('')
    const model = profileModel(overview.stats!)
    expect(model.total).toBe(model.modelTotal)
    expect(model.total).toBeGreaterThan(model.recentTotal)
    expect(model.cacheRate).toBe('95%')
    expect(overview.stats?.activeDays).toBe(75)
    const denied = await fetch(`${client.host.url}/api/desktop-ui/preferences/profile`)
    expect(denied.status).toBe(401)
  } finally {
    await fixture.close()
  }
})
