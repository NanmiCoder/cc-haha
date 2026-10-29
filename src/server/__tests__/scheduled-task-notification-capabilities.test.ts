import { expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSandboxedTestEnvironment, removeTestSandbox } from '../../../scripts/pr/test-environment'

test('paired remote phones read only notification readiness and can save those channels', () => {
  const home = mkdtempSync(join(tmpdir(), 'scheduled-notification-capabilities-'))
  try {
    const script = `
      const assert = (await import('node:assert/strict')).default
      const { mkdir, writeFile, readFile } = await import('node:fs/promises')
      const { join } = await import('node:path')
      const { PublicAccessServer } = await import(${JSON.stringify(import.meta.resolve('../publicAccess'))})
      const { handleScheduledTasksApi } = await import(${JSON.stringify(import.meta.resolve('../api/scheduled-tasks'))})
      const config = process.env.CLAUDE_CONFIG_DIR
      await mkdir(config, { recursive: true })
      const configPath = join(config, 'adapters.json')
      const origin = 'https://workstation.fixture.ts.net:8443'
      const service = new PublicAccessServer({
        storePath: join(process.env.HOME, 'devices.json'), serverPort: () => 3456,
        handleApiRequest: (request, url) => handleScheduledTasksApi(request, url, url.pathname.slice(1).split('/')),
        handleStatic: async () => null, websocket: { message() {} },
      })
      service.enable(origin)
      try {
        const base = 'http://127.0.0.1:' + service.status().port
        const request = (path, init = {}, token) => fetch(base + path, {
          ...init, headers: { Origin: origin, ...(token ? { Authorization: 'Bearer ' + token } : {}), ...init.headers },
        })
        const control = (route, body = {}) => service.control(new Request('http://localhost/api/public-access/' + route, {
          method: 'POST', headers: { Authorization: 'Bearer notification-fixture-control' }, body: JSON.stringify(body),
        }))
        const endpoint = '/api/scheduled-tasks/notification-capabilities'
        assert.equal((await request(endpoint)).status, 401)
        const { secret } = await (await control('pairing')).json()
        const pair = await (await request('/api/public-access/pair', { method: 'POST', body: JSON.stringify({ secret, name: 'Fixture phone', clientType: 'native' }) })).json()
        await control('approve', { id: pair.id })
        const claim = await (await request('/api/public-access/claim', { method: 'POST', body: JSON.stringify(pair) })).json()
        assert.ok(claim.token.startsWith('native_'))
        const configured = {
          telegram: { botToken: 'fake-telegram-secret', pairedUsers: [{ userId: 7, displayName: 'Private person', pairedAt: 1 }], defaultWorkDir: '/private/project' },
          feishu: { appId: 'private-app-id', appSecret: 'fake-feishu-secret', allowedUsers: ['private-open-id'] },
          pairing: { code: 'private-pair-code' },
        }
        await writeFile(configPath, JSON.stringify(configured))
        const response = await request(endpoint, {}, claim.token)
        assert.equal(response.status, 200, await response.clone().text())
        const text = await response.text()
        assert.deepEqual(JSON.parse(text), { channels: { desktop: true, feishu: true, telegram: true } })
        for (const secret of ['fake-telegram-secret', 'fake-feishu-secret', 'private-app-id', 'private-open-id', 'Private person', '/private/project', 'private-pair-code', 'botToken', 'appSecret', 'pairedUsers']) assert.ok(!text.includes(secret), secret)
        assert.equal((await request('/api/adapters', {}, claim.token)).status, 403)
        for (const method of ['POST', 'PUT', 'DELETE']) assert.equal((await request(endpoint, { method, body: '{}' }, claim.token)).status, 403)
        assert.equal((await request(endpoint + '/extra', {}, claim.token)).status, 403)
        assert.equal((await request(endpoint + '?include=secrets', {}, claim.token)).status, 403)
        const input = { name: 'Remote notifications', prompt: 'Check build', execution: { kind: 'session', targetSessionId: 'fixture-chat' }, schedule: { kind: 'cron', expression: '0 9 * * *', timeZone: 'UTC' }, notificationPolicy: 'failed', notification: { enabled: true, channels: ['desktop', 'feishu', 'telegram'] } }
        const created = await request('/api/scheduled-tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }, claim.token)
        assert.equal(created.status, 201)
        const { task } = await created.json()
        assert.deepEqual(task.notification, input.notification)
        const saved = JSON.parse(await readFile(join(config, 'scheduled_tasks.json'), 'utf8'))
        assert.deepEqual(saved.tasks[0].notification, input.notification)
        for (const [value, expected] of [
          [{}, { desktop: true, feishu: false, telegram: false }],
          [{ telegram: { botToken: 'fake' }, feishu: { appId: 'fake', appSecret: 'fake' } }, { desktop: true, feishu: false, telegram: false }],
          [{ telegram: { botToken: 'fake', allowedUsers: [8] }, feishu: { appId: 'fake', pairedUsers: [{ userId: 'fake' }] } }, { desktop: true, feishu: false, telegram: true }],
        ]) {
          await writeFile(configPath, JSON.stringify(value))
          const response = await request(endpoint, {}, claim.token)
          assert.equal(response.status, 200)
          assert.deepEqual(await response.json(), { channels: expected })
        }
        await control('revoke', { id: claim.deviceId })
        assert.equal((await request(endpoint, {}, claim.token)).status, 401)
      } finally { service.disable() }
    `
    expect(() => execFileSync(process.execPath, ['--no-env-file', '-e', script], {
      env: createSandboxedTestEnvironment(home, { CC_HAHA_LOCAL_ACCESS_TOKEN: 'notification-fixture-control' }),
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20_000,
    })).not.toThrow()
  } finally { removeTestSandbox(home, 'scheduled-notification-capabilities') }
})
