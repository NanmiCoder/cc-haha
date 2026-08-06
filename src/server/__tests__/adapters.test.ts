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
