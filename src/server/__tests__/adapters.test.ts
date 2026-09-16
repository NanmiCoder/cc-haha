import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { handleAdaptersApi, cleanupStaleWhatsAppLoginDirectories } from '../api/adapters.js'

let tmpDir: string
let originalConfigDir: string | undefined

async function setup() {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-adapters-test-'))
  originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = tmpDir
}

async function teardown() {
  if (originalConfigDir !== undefined) {
    process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  } else {
    delete process.env.CLAUDE_CONFIG_DIR
  }
  await fs.rm(tmpDir, { recursive: true, force: true })
}

function makeRequest(method: string, pathName: string, body?: Record<string, unknown>) {
  const url = new URL(pathName, 'http://localhost:3456')
  const req = new Request(url.toString(), {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const segments = url.pathname.split('/').filter(Boolean)
  return { req, url, segments }
}

function makeRawRequest(method: string, pathName: string, body: string) {
  const url = new URL(pathName, 'http://localhost:3456')
  const req = new Request(url.toString(), {
    method,
    headers: { 'Content-Type': 'application/json' },
    body,
  })
  return { req, url, segments: url.pathname.split('/').filter(Boolean) }
}

async function writeRawConfig(config: Record<string, unknown>) {
  await fs.writeFile(
    path.join(tmpDir, 'adapters.json'),
    JSON.stringify(config, null, 2),
    { mode: 0o600 },
  )
}

describe('Adapters API', () => {
  beforeEach(setup)
  afterEach(teardown)

  it('masks WeChat bot tokens in GET responses', async () => {
    await writeRawConfig({
      wechat: {
        accountId: 'bot-1',
        botToken: 'wechat-secret-token',
        baseUrl: 'https://ilinkai.weixin.qq.com',
        userId: 'wx-user',
        pairedUsers: [{ userId: 'wx-user', displayName: 'WeChat User', pairedAt: 1 }],
      },
    })

    const get = makeRequest('GET', '/api/adapters')
    const res = await handleAdaptersApi(get.req, get.url, get.segments)
    expect(res.status).toBe(200)
    const json = await res.json() as any
    expect(json.wechat.botToken).toBe('****oken')
    expect(json.wechat.accountId).toBe('bot-1')
  })

  it('writes adapter credentials with owner-only permissions', async () => {
    const put = makeRequest('PUT', '/api/adapters', {
      telegram: {
        botToken: 'telegram-secret-token',
      },
    })
    expect((await handleAdaptersApi(put.req, put.url, put.segments)).status).toBe(200)

    const configPath = path.join(tmpDir, 'adapters.json')
    const stat = await fs.stat(configPath)
    if (process.platform === 'win32') {
      expect(stat.isFile()).toBe(true)
      return
    }
    expect(stat.mode & 0o777).toBe(0o600)
  })

  it('masks and preserves DingTalk client secrets', async () => {
    const put = makeRequest('PUT', '/api/adapters', {
      dingtalk: {
        clientId: 'ding-client-1',
        clientSecret: 'dingtalk-client-secret',
        permissionCardTemplateId: 'permission-template',
        pairedUsers: [{ userId: 'ding-user', displayName: 'DingTalk User', pairedAt: 1 }],
      },
    })
    expect((await handleAdaptersApi(put.req, put.url, put.segments)).status).toBe(200)

    const get = makeRequest('GET', '/api/adapters')
    const res = await handleAdaptersApi(get.req, get.url, get.segments)
    expect(res.status).toBe(200)
    const json = await res.json() as any
    expect(json.dingtalk.clientSecret).toBe('****cret')
    expect(json.dingtalk.clientId).toBe('ding-client-1')
    expect(json.dingtalk.permissionCardTemplateId).toBe('permission-template')

    const maskedPut = makeRequest('PUT', '/api/adapters', {
      dingtalk: {
        clientSecret: json.dingtalk.clientSecret,
        allowedUsers: ['ding-user'],
      },
    })
    expect((await handleAdaptersApi(maskedPut.req, maskedPut.url, maskedPut.segments)).status).toBe(200)

    const raw = JSON.parse(await fs.readFile(path.join(tmpDir, 'adapters.json'), 'utf-8')) as any
    expect(raw.dingtalk.clientSecret).toBe('dingtalk-client-secret')
    expect(raw.dingtalk.allowedUsers).toEqual(['ding-user'])
    expect(raw.dingtalk.permissionCardTemplateId).toBe('permission-template')
  })

  it('clears WeChat credentials on unbind', async () => {
    await writeRawConfig({
      wechat: {
        accountId: 'bot-1',
        botToken: 'wechat-secret-token',
        userId: 'wx-user',
        allowedUsers: ['wx-allowed-user'],
        pairedUsers: [{ userId: 'wx-user', displayName: 'WeChat User', pairedAt: 1 }],
      },
    })

    const unbind = makeRequest('POST', '/api/adapters/wechat/unbind')
    const res = await handleAdaptersApi(unbind.req, unbind.url, unbind.segments)
    expect(res.status).toBe(200)
    const json = await res.json() as any
    expect(json.wechat.botToken).toBeUndefined()
    expect(json.wechat.accountId).toBeUndefined()
    expect(json.wechat.userId).toBeUndefined()
    expect(json.wechat.allowedUsers).toEqual([])
    expect(json.wechat.pairedUsers).toEqual([])
  })

  it('clears DingTalk credentials on unbind', async () => {
    const put = makeRequest('PUT', '/api/adapters', {
      dingtalk: {
        clientId: 'ding-client-1',
        clientSecret: 'dingtalk-client-secret',
        allowedUsers: ['ding-allowed-user'],
        permissionCardTemplateId: 'permission-template',
        pairedUsers: [{ userId: 'ding-user', displayName: 'DingTalk User', pairedAt: 1 }],
      },
    })
    await handleAdaptersApi(put.req, put.url, put.segments)

    const unbind = makeRequest('POST', '/api/adapters/dingtalk/unbind')
    const res = await handleAdaptersApi(unbind.req, unbind.url, unbind.segments)
    expect(res.status).toBe(200)
    const json = await res.json() as any
    expect(json.dingtalk.clientId).toBeUndefined()
    expect(json.dingtalk.clientSecret).toBeUndefined()
    expect(json.dingtalk.allowedUsers).toEqual([])
    expect(json.dingtalk.permissionCardTemplateId).toBeUndefined()
    expect(json.dingtalk.pairedUsers).toEqual([])
  })

  it('stores and clears WhatsApp account binding', async () => {
    const authDir = path.join(tmpDir, 'whatsapp-auth', 'default')
    await fs.mkdir(authDir, { recursive: true })
    await fs.writeFile(path.join(authDir, 'creds.json'), '{}')
    await writeRawConfig({
      whatsapp: {
        accountJid: '15551234567@s.whatsapp.net',
        authDir,
        allowedUsers: ['15550000000@s.whatsapp.net'],
        pairedUsers: [{ userId: '15551234567@s.whatsapp.net', displayName: 'WhatsApp User', pairedAt: 1 }],
      },
    })

    const get = makeRequest('GET', '/api/adapters')
    const getRes = await handleAdaptersApi(get.req, get.url, get.segments)
    const before = await getRes.json() as any
    expect(before.whatsapp.accountJid).toBe('15551234567@s.whatsapp.net')
    expect(before.whatsapp.authDir).toBe(authDir)

    const unbind = makeRequest('POST', '/api/adapters/whatsapp/unbind')
    const res = await handleAdaptersApi(unbind.req, unbind.url, unbind.segments)
    expect(res.status).toBe(200)
    const json = await res.json() as any
    expect(json.whatsapp.accountJid).toBeUndefined()
    expect(json.whatsapp.allowedUsers).toEqual([])
    expect(json.whatsapp.pairedUsers).toEqual([])
    await expect(fs.stat(path.join(authDir, 'creds.json'))).rejects.toThrow()
  })

  it('rejects malformed and binding-owned config fields', async () => {
    for (const request of [
      makeRawRequest('PUT', '/api/adapters', 'null'),
      makeRawRequest('PUT', '/api/adapters', '[]'),
      makeRawRequest('PUT', '/api/adapters', '{broken'),
      makeRequest('PUT', '/api/adapters', { feishu: { streamingCard: 'yes' } }),
      makeRequest('PUT', '/api/adapters', { telegram: { allowedUsers: [-1] } }),
      makeRequest('PUT', '/api/adapters', { wechat: { botToken: 'not-allowed' } }),
      makeRequest('PUT', '/api/adapters', { whatsapp: { authDir: '/tmp/not-allowed' } }),
    ]) {
      const response = await handleAdaptersApi(request.req, request.url, request.segments)
      expect(response.status).toBe(400)
    }
    await expect(fs.stat(path.join(tmpDir, 'adapters.json'))).rejects.toThrow()
  })

  // #1191: the IM path boundary is configured separately from the default project,
  // globally and per platform.
  it('persists allowed project roots globally and per platform', async () => {
    const request = makeRequest('PUT', '/api/adapters', {
      allowedProjectRoots: ['~/work', '/srv/projects'],
      feishu: { allowedProjectRoots: ['~/work/only-this'] },
    })
    const response = await handleAdaptersApi(request.req, request.url, request.segments)
    expect(response.status).toBe(200)

    const saved = JSON.parse(await fs.readFile(path.join(tmpDir, 'adapters.json'), 'utf-8'))
    expect(saved.allowedProjectRoots).toEqual(['~/work', '/srv/projects'])
    expect(saved.feishu.allowedProjectRoots).toEqual(['~/work/only-this'])

    // The settings UI reads these back from GET; masking must not drop them.
    const read = makeRequest('GET', '/api/adapters')
    const config = await (await handleAdaptersApi(read.req, read.url, read.segments)).json() as Record<string, any>
    expect(config.allowedProjectRoots).toEqual(['~/work', '/srv/projects'])
    expect(config.feishu.allowedProjectRoots).toEqual(['~/work/only-this'])
  })

  it('rejects malformed allowed project roots', async () => {
    for (const request of [
      makeRequest('PUT', '/api/adapters', { allowedProjectRoots: '/not-an-array' }),
      makeRequest('PUT', '/api/adapters', { allowedProjectRoots: [''] }),
      makeRequest('PUT', '/api/adapters', { allowedProjectRoots: [123] }),
      makeRequest('PUT', '/api/adapters', { telegram: { allowedProjectRoots: [null] } }),
    ]) {
      const response = await handleAdaptersApi(request.req, request.url, request.segments)
      expect(response.status).toBe(400)
    }
    await expect(fs.stat(path.join(tmpDir, 'adapters.json'))).rejects.toThrow()
  })

  it('rejects malformed QR polling payloads before invoking platform protocols', async () => {
    for (const request of [
      makeRawRequest('POST', '/api/adapters/wechat/login/poll', 'null'),
      makeRawRequest('POST', '/api/adapters/wechat/login/poll', '{broken'),
      makeRawRequest('POST', '/api/adapters/whatsapp/login/poll', '[]'),
      makeRequest('POST', '/api/adapters/dingtalk/registration/poll', { deviceCode: '' }),
    ]) {
      const response = await handleAdaptersApi(request.req, request.url, request.segments)
      expect(response.status).toBe(400)
    }
  })

  it('never recursively deletes a legacy WhatsApp auth directory outside the managed root', async () => {
    const externalDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-haha-whatsapp-sentinel-'))
    const sentinel = path.join(externalDir, 'keep.txt')
    await fs.writeFile(sentinel, 'keep')
    try {
      await writeRawConfig({
        whatsapp: {
          accountJid: 'legacy@s.whatsapp.net',
          authDir: externalDir,
          allowedUsers: [],
          pairedUsers: [],
        },
      })

      const unbind = makeRequest('POST', '/api/adapters/whatsapp/unbind')
      const response = await handleAdaptersApi(unbind.req, unbind.url, unbind.segments)
      expect(response.status).toBe(200)
      expect(await fs.readFile(sentinel, 'utf-8')).toBe('keep')
    } finally {
      await fs.rm(externalDir, { recursive: true, force: true })
    }
  })

  it('serializes concurrent config patches without losing either update', async () => {
    const telegram = makeRequest('PUT', '/api/adapters', {
      telegram: { botToken: 'telegram-token', allowedUsers: [123] },
    })
    const feishu = makeRequest('PUT', '/api/adapters', {
      feishu: { appId: 'cli_test', appSecret: 'feishu-secret', allowedUsers: ['ou_test'] },
    })

    const responses = await Promise.all([
      handleAdaptersApi(telegram.req, telegram.url, telegram.segments),
      handleAdaptersApi(feishu.req, feishu.url, feishu.segments),
    ])
    expect(responses.map((response) => response.status)).toEqual([200, 200])

    const raw = JSON.parse(await fs.readFile(path.join(tmpDir, 'adapters.json'), 'utf-8')) as any
    expect(raw.telegram).toMatchObject({ botToken: 'telegram-token', allowedUsers: [123] })
    expect(raw.feishu).toMatchObject({ appId: 'cli_test', appSecret: 'feishu-secret', allowedUsers: ['ou_test'] })
  })

  it('logs the original read error internally while returning a sanitized response', async () => {
    await writeRawConfig({ telegram: { botToken: 'telegram-token' } })
    const consoleErrorSpy = spyOn(console, 'error').mockImplementation(() => {})
    const readFileSpy = spyOn(fs, 'readFile').mockRejectedValue(new Error('EPERM: read denied'))

    try {
      const { req, url, segments } = makeRequest('GET', '/api/adapters')
      const response = await handleAdaptersApi(req, url, segments)
      expect(response.status).toBe(500)
      const json = await response.json() as any
      expect(json.message).toBe('Failed to read adapter config')
      expect(consoleErrorSpy).toHaveBeenCalled()
      const callArgs = consoleErrorSpy.mock.calls[0] as unknown[]
      expect(callArgs.some((arg) => String(arg).includes('EPERM: read denied'))).toBe(true)
    } finally {
      readFileSpy.mockRestore()
      consoleErrorSpy.mockRestore()
    }
  })

  it('logs the original write error internally while returning a sanitized response', async () => {
    const consoleErrorSpy = spyOn(console, 'error').mockImplementation(() => {})
    const writeFileSpy = spyOn(fs, 'writeFile').mockRejectedValue(new Error('ENOSPC: no space left'))

    try {
      const { req, url, segments } = makeRequest('PUT', '/api/adapters', {
        telegram: { botToken: 'telegram-token' },
      })
      const response = await handleAdaptersApi(req, url, segments)
      expect(response.status).toBe(500)
      const json = await response.json() as any
      expect(json.message).toBe('Failed to write adapter config')
      expect(consoleErrorSpy).toHaveBeenCalled()
      const callArgs = consoleErrorSpy.mock.calls[0] as unknown[]
      expect(callArgs.some((arg) => String(arg).includes('ENOSPC: no space left'))).toBe(true)
    } finally {
      writeFileSpy.mockRestore()
      consoleErrorSpy.mockRestore()
    }
  })

  it('cleans up stale WhatsApp login staging directories on startup', async () => {
    const managedRoot = path.join(tmpDir, 'whatsapp-auth')
    const staleDir = path.join(managedRoot, '.login-stale')
    const freshDir = path.join(managedRoot, '.login-fresh')
    const symlinksDir = path.join(managedRoot, '.login-symlink')
    const victim = path.join(tmpDir, 'victim')
    await fs.mkdir(staleDir, { recursive: true })
    await fs.mkdir(freshDir, { recursive: true })
    await fs.mkdir(victim, { recursive: true })
    await fs.writeFile(path.join(staleDir, 'creds.json'), '{}')
    await fs.writeFile(path.join(freshDir, 'creds.json'), '{}')
    await fs.writeFile(path.join(victim, 'keep.txt'), 'keep')
    await fs.symlink(victim, symlinksDir)

    const staleDate = new Date(Date.now() - (3 * 60 * 1000) - 60_000)
    await fs.utimes(staleDir, staleDate, staleDate)

    await cleanupStaleWhatsAppLoginDirectories()

    await expect(fs.stat(path.join(staleDir, 'creds.json'))).rejects.toThrow()
    expect(await fs.stat(path.join(freshDir, 'creds.json'))).toBeDefined()
    expect(await fs.stat(path.join(victim, 'keep.txt'))).toBeDefined()
    expect(await fs.lstat(symlinksDir).then((s) => s.isSymbolicLink())).toBe(true)
  })
})

describe('Adapters API — WeCom / QQ / Slack', () => {
  beforeEach(setup)
  afterEach(teardown)

  // Every credential the settings page reads back must be masked, or a
  // screenshot or a support log leaks a working bot secret.
  it.each([
    ['wecom', { botId: 'bot-1', secret: 'wecom-secret-value' }, 'secret'],
    ['qq', { appId: 'app-1', appSecret: 'qq-secret-value' }, 'appSecret'],
    ['slack', { botToken: 'xoxb-secret-value', appToken: 'xapp-secret-value' }, 'botToken'],
  ] as const)('masks the %s secret in GET responses', async (platform, config, field) => {
    await writeRawConfig({ [platform]: config })

    const get = makeRequest('GET', '/api/adapters')
    const json = await (await handleAdaptersApi(get.req, get.url, get.segments)).json() as any

    expect(json[platform][field]).toBe('****alue')
  })

  it('masks both Slack tokens independently', async () => {
    await writeRawConfig({ slack: { botToken: 'xoxb-aaaa1111', appToken: 'xapp-bbbb2222' } })

    const get = makeRequest('GET', '/api/adapters')
    const json = await (await handleAdaptersApi(get.req, get.url, get.segments)).json() as any

    expect(json.slack.botToken).toBe('****1111')
    expect(json.slack.appToken).toBe('****2222')
  })

  // Round trip: saving the masked value the UI just rendered must not wipe the
  // real credential.
  it.each([
    ['wecom', 'secret', { botId: 'bot-1', secret: 'wecom-secret-value' }],
    ['qq', 'appSecret', { appId: 'app-1', appSecret: 'qq-secret-value' }],
    ['slack', 'appToken', { botToken: 'xoxb-1', appToken: 'xapp-secret-value' }],
  ] as const)('keeps the stored %s.%s when the UI sends back the mask', async (platform, field, config) => {
    await writeRawConfig({ [platform]: config })

    const get = makeRequest('GET', '/api/adapters')
    const masked = await (await handleAdaptersApi(get.req, get.url, get.segments)).json() as any

    const put = makeRequest('PUT', '/api/adapters', {
      [platform]: { [field]: masked[platform][field], allowedUsers: ['someone'] },
    })
    expect((await handleAdaptersApi(put.req, put.url, put.segments)).status).toBe(200)

    const raw = JSON.parse(await fs.readFile(path.join(tmpDir, 'adapters.json'), 'utf-8'))
    expect(raw[platform][field]).toBe((config as Record<string, string>)[field])
    expect(raw[platform].allowedUsers).toEqual(['someone'])
  })

  it.each(['wecom', 'qq', 'slack'] as const)('rejects an unknown %s config key', async (platform) => {
    const put = makeRequest('PUT', '/api/adapters', { [platform]: { nope: 'x' } })
    const res = await handleAdaptersApi(put.req, put.url, put.segments)

    expect(res.status).toBe(400)
  })

  it.each([
    ['wecom', { botId: 'bot-1', secret: 's' }],
    ['qq', { appId: 'app-1', appSecret: 's' }],
    ['slack', { botToken: 'xoxb-1', appToken: 'xapp-1' }],
  ] as const)('clears %s credentials and pairings on unbind', async (platform, config) => {
    await writeRawConfig({
      [platform]: {
        ...config,
        allowedUsers: ['someone'],
        pairedUsers: [{ userId: 'someone', displayName: 'Someone', pairedAt: 1 }],
      },
    })

    const unbind = makeRequest('POST', `/api/adapters/${platform}/unbind`)
    expect((await handleAdaptersApi(unbind.req, unbind.url, unbind.segments)).status).toBe(200)

    const raw = JSON.parse(await fs.readFile(path.join(tmpDir, 'adapters.json'), 'utf-8'))
    expect(raw[platform].allowedUsers).toEqual([])
    expect(raw[platform].pairedUsers).toEqual([])
    for (const key of Object.keys(config)) {
      expect(raw[platform][key]).toBeUndefined()
    }
  })

  it('serves a Slack manifest with Socket Mode and a create-app link', async () => {
    const get = makeRequest('GET', '/api/adapters/slack/manifest')
    const res = await handleAdaptersApi(get.req, get.url, get.segments)

    expect(res.status).toBe(200)
    const json = await res.json() as any
    const manifest = JSON.parse(json.manifest)
    expect(manifest.settings.socket_mode_enabled).toBe(true)
    expect(new URL(json.createAppUrl).origin).toBe('https://api.slack.com')
  })

  it.each([
    ['wecom', '/api/adapters/wecom/login/poll'],
    ['qq', '/api/adapters/qq/login/poll'],
  ] as const)('reports an unknown %s login session instead of failing', async (_platform, endpoint) => {
    const poll = makeRequest('POST', endpoint, { sessionKey: 'no-such-session' })
    const res = await handleAdaptersApi(poll.req, poll.url, poll.segments)

    expect(res.status).toBe(200)
    expect(await res.json() as any).toMatchObject({ connected: false, status: 'not_started' })
  })

  it.each([
    '/api/adapters/wecom/login/poll',
    '/api/adapters/qq/login/poll',
    '/api/adapters/feishu/registration/poll',
  ])('rejects %s without a session key', async (endpoint) => {
    const poll = makeRequest('POST', endpoint, {})
    const res = await handleAdaptersApi(poll.req, poll.url, poll.segments)

    expect(res.status).toBe(400)
  })

  it('rejects an unknown sub-route on a platform namespace', async () => {
    const req = makeRequest('POST', '/api/adapters/slack/nonsense')
    expect((await handleAdaptersApi(req.req, req.url, req.segments)).status).toBe(404)
  })
})

describe('Adapters API — Feishu scan-to-create', () => {
  beforeEach(setup)
  afterEach(teardown)

  it('reports an unknown registration session instead of failing', async () => {
    const poll = makeRequest('POST', '/api/adapters/feishu/registration/poll', {
      sessionKey: 'no-such-session',
    })
    const res = await handleAdaptersApi(poll.req, poll.url, poll.segments)

    expect(res.status).toBe(200)
    expect(await res.json() as any).toMatchObject({ status: 'not_started' })
  })

  it('accepts a cancel for a session it does not know', async () => {
    const cancel = makeRequest('POST', '/api/adapters/feishu/registration/cancel', {
      sessionKey: 'no-such-session',
    })
    const res = await handleAdaptersApi(cancel.req, cancel.url, cancel.segments)

    expect(res.status).toBe(200)
    expect(await res.json() as any).toMatchObject({ status: 'cancelled' })
  })

  it('clears Feishu credentials and pairings on unbind', async () => {
    await writeRawConfig({
      feishu: {
        appId: 'cli_1',
        appSecret: 'secret',
        encryptKey: 'ek',
        verificationToken: 'vt',
        allowedUsers: ['ou_1'],
        pairedUsers: [{ userId: 'ou_1', displayName: 'Feishu User', pairedAt: 1 }],
        streamingCard: true,
      },
    })

    const unbind = makeRequest('POST', '/api/adapters/feishu/unbind')
    expect((await handleAdaptersApi(unbind.req, unbind.url, unbind.segments)).status).toBe(200)

    const raw = JSON.parse(await fs.readFile(path.join(tmpDir, 'adapters.json'), 'utf-8'))
    expect(raw.feishu.appId).toBeUndefined()
    expect(raw.feishu.appSecret).toBeUndefined()
    expect(raw.feishu.allowedUsers).toEqual([])
    expect(raw.feishu.pairedUsers).toEqual([])
    // Unbinding a bot must not reset unrelated presentation preferences.
    expect(raw.feishu.streamingCard).toBe(true)
  })
})

describe('Adapters API — Feishu tenant domain', () => {
  beforeEach(setup)
  afterEach(teardown)

  // A bot provisioned by an international (Lark) tenant authenticates against
  // open.larksuite.com. Losing the brand here means the scan reports success
  // and the adapter then fails to connect with an unrelated-looking error.
  it('accepts and stores a lark domain', async () => {
    const put = makeRequest('PUT', '/api/adapters', {
      feishu: { appId: 'cli_1', appSecret: 's', domain: 'lark' },
    })
    expect((await handleAdaptersApi(put.req, put.url, put.segments)).status).toBe(200)

    const raw = JSON.parse(await fs.readFile(path.join(tmpDir, 'adapters.json'), 'utf-8'))
    expect(raw.feishu.domain).toBe('lark')
  })

  it('rejects a domain that is neither feishu nor lark', async () => {
    const put = makeRequest('PUT', '/api/adapters', {
      feishu: { domain: 'example.com' },
    })
    const res = await handleAdaptersApi(put.req, put.url, put.segments)

    expect(res.status).toBe(400)
  })

  it('drops the domain along with the credentials on unbind', async () => {
    await writeRawConfig({ feishu: { appId: 'cli_1', appSecret: 's', domain: 'lark' } })

    const unbind = makeRequest('POST', '/api/adapters/feishu/unbind')
    expect((await handleAdaptersApi(unbind.req, unbind.url, unbind.segments)).status).toBe(200)

    const raw = JSON.parse(await fs.readFile(path.join(tmpDir, 'adapters.json'), 'utf-8'))
    expect(raw.feishu.domain).toBeUndefined()
  })
})
