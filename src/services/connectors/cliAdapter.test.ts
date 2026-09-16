import { createHash } from 'node:crypto'
import { expect, test } from 'bun:test'
import fixtures from './fixtures/status-output.json'
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CONNECTORS } from './catalog.js'
import { createConnectorAdapter, parseConnectorCheck, trustedAuthorizationUrl } from './cliAdapter.js'
import { managedInstallation, type RuntimeDependencies } from './managedRuntime.js'

const result = (value: unknown, code = 0) => ({ stdout: typeof value === 'string' ? value : JSON.stringify(value), stderr: '', code })
test('pinned CLI output parsers distinguish configured, verified, expired and malformed results', () => {
  expect(parseConnectorCheck('feishu', result(fixtures.feishuVerified))).toEqual({ authenticated: true, verification: 'remote' })
  expect(parseConnectorCheck('feishu', result({ identity: 'user', verified: false })).authenticated).toBe(false)
  expect(parseConnectorCheck('feishu', result({ identity: 'bot', verified: true })).authenticated).toBe(false)
  expect(parseConnectorCheck('feishu', result({ ok: false, error: { type: 'config', subtype: 'not_configured' } }, 1)).authenticated).toBe(false)
  expect(parseConnectorCheck('dingtalk', result(fixtures.dingtalkSignedOut)).authenticated).toBe(false)
  expect(parseConnectorCheck('dingtalk', result({ success: true, authenticated: true })).authenticated).toBe(true)
  expect(parseConnectorCheck('wecom', result('authorized\n'))).toEqual({ authenticated: true, verification: 'local' })
  expect(parseConnectorCheck('wecom', result(fixtures.wecomSignedOut)).authenticated).toBe(false)
  for (const id of ['feishu', 'dingtalk', 'wecom'] as const) expect(() => parseConnectorCheck(id, result('not json'))).toThrow()
  expect(() => parseConnectorCheck('dingtalk', result({ success: false, authenticated: true }, 1))).toThrow()
})

test('authorization URLs must match exact vendor HTTPS hosts', () => {
  expect(trustedAuthorizationUrl('wecom', 'https://work.weixin.qq.com/ai/qc/gen?scode=fake')).toBeDefined()
  for (const url of ['https://work.weixin.qq.com.evil.test/', 'http://work.weixin.qq.com/', 'https://token@work.weixin.qq.com/', 'https://work.weixin.qq.com:123/']) {
    expect(trustedAuthorizationUrl('wecom', url)).toBeUndefined()
  }
})

test('authorization reports complete streamed URLs and always disables browser opening', async () => {
  const def = CONNECTORS[2]!
  const calls: string[][] = []
  const dep: RuntimeDependencies = {
    readBinary: async () => Buffer.from('binary'),
    binaryIntegrity: () => 'sha256-' + createHash('sha256').update('binary').digest('hex'),
    platform: 'win32', arch: 'x64', download: async () => new Uint8Array(), extract: async () => new Uint8Array(),
    async run(_command, args, options) {
      calls.push(args)
      options.onOutput?.('https://work.weixin.qq.com/ai/')
      options.onOutput?.('qc/gen?scode=fake\n')
      return result('ok')
    },
  }
  const updates: string[] = []
  const adapter = createConnectorAdapter(def, '/tmp/connector fake root', dep)
  await adapter.authenticate(managedInstallation(def, '/tmp/connector fake root', dep), new AbortController().signal, (_phase, url) => { if (url) updates.push(url) })
  expect(calls[0]).toEqual(['auth', 'init', '--no-browser', '--noninteractive'])
  expect(updates).toEqual(['https://work.weixin.qq.com/ai/qc/gen?scode=fake'])
})

test('remove rejects foreign directory instead of deleting user credentials', async () => {
  const adapter = createConnectorAdapter(CONNECTORS[0]!, '/tmp/managed')
  await expect(adapter.remove({ directory: '/tmp/shared-credentials', command: '/tmp/shared-credentials/lark-cli', args: [], env: {} })).rejects.toThrow('Invalid managed')
})

test('remove cleans only owned versions and interrupted stages, preserving account data', async () => {
  const root = await mkdtemp(join(tmpdir(), 'connector remove '))
  try {
    const definition = CONNECTORS[0]!
    const installed = managedInstallation(definition, root)
    await mkdir(installed.directory, { recursive: true })
    await mkdir(join(root, 'runtime', 'feishu', '0.9.0-old'), { recursive: true })
    await mkdir(join(root, 'runtime', 'feishu', '1.0.95.stage-interrupted'), { recursive: true })
    await mkdir(join(root, 'runtime', 'wecom'), { recursive: true })
    await mkdir(join(root, 'accounts', 'feishu'), { recursive: true })
    const account = join(root, 'accounts', 'feishu', 'fixture.json')
    await writeFile(account, 'keep synthetic credential')
    await createConnectorAdapter(definition, root).remove(installed)
    await expect(access(join(root, 'runtime', 'feishu'))).rejects.toThrow()
    expect(await readFile(account, 'utf8')).toBe('keep synthetic credential')
    await access(join(root, 'runtime', 'wecom'))
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('Feishu structured stderr failure permits first-time configuration but never a false success', async () => {
  const missing = { code: 1, stdout: '', stderr: JSON.stringify(fixtures.feishuNotConfigured) }
  expect(parseConnectorCheck('feishu', missing)).toEqual({ authenticated: false, verification: 'local' })
  expect(() => parseConnectorCheck('feishu', { ...missing, code: 0 })).toThrow('Unexpected connector')
  expect(() => parseConnectorCheck('feishu', { code: 1, stdout: '', stderr: JSON.stringify(fixtures.feishuVerified) })).toThrow('Unable to check')
  const calls: string[][] = []
  const dependencies: RuntimeDependencies = {
    readBinary: async () => Buffer.from('binary'),
    binaryIntegrity: () => 'sha256-' + createHash('sha256').update('binary').digest('hex'),
    platform: 'darwin', arch: 'arm64', download: async () => new Uint8Array(), extract: async () => new Uint8Array(),
    async run(_command, args) {
      calls.push(args)
      return calls.length === 1 ? missing : result({ ok: true })
    },
  }
  const definition = CONNECTORS[0]!
  await createConnectorAdapter(definition, '/tmp/connector first login fixture', dependencies).authenticate(
    managedInstallation(definition, '/tmp/connector first login fixture', dependencies), new AbortController().signal, () => {},
  )
  expect(calls).toEqual([
    ['auth', 'status', '--json'],
    ['config', 'init', '--new', '--brand', 'feishu'],
    ['auth', 'login', '--recommend', '--json'],
  ])
})

test('Feishu account label only reads the documented name field, never identity metadata', () => {
  const check = parseConnectorCheck('feishu', result({
    identity: 'user', verified: true,
    identities: { user: { userName: ' 张三\u0000 ', tokenStatus: 'synthetic-token-marker', accessToken: 'never-return', email: 'not-documented' } },
  }))
  expect(check.accountLabel).toBe('张三')
  expect(JSON.stringify(check)).not.toContain('never-return')
  expect(JSON.stringify(check)).not.toContain('synthetic-token')
})

test('status check rejects an unknown persisted version before spawning its command', async () => {
  const definition = { ...CONNECTORS[0]!, version: '9.9.9' }
  await expect(createConnectorAdapter(definition, '/tmp/untrusted-version').check({
    directory: '/tmp/untrusted-version/runtime/feishu/9.9.9-darwin-arm64',
    command: '/tmp/untrusted-version/runtime/feishu/9.9.9-darwin-arm64/lark-cli', args: [], env: {},
  }, new AbortController().signal)).rejects.toThrow('no pinned artifact')
})

test('every check and authentication verifies the installed bytes before executing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'connector tamper fixture '))
  let executions = 0
  const dependencies: RuntimeDependencies = {
    platform: 'darwin', arch: 'arm64',
    binaryIntegrity: () => 'sha256-' + createHash('sha256').update('binary').digest('hex'),
    download: async () => new Uint8Array(), extract: async () => new Uint8Array(),
    async run() { executions++; return result('authorized') },
  }
  try {
    const definition = CONNECTORS[2]!
    const installation = managedInstallation(definition, root, dependencies)
    await mkdir(installation.directory, { recursive: true })
    await writeFile(installation.command, 'binary')
    const adapter = createConnectorAdapter(definition, root, dependencies)
    expect((await adapter.check(installation, new AbortController().signal)).authenticated).toBe(true)
    await writeFile(installation.command, 'replaced after restart')
    await expect(adapter.check(installation, new AbortController().signal)).rejects.toThrow('checksum mismatch')
    await expect(adapter.authenticate(installation, new AbortController().signal, () => {})).rejects.toThrow('checksum mismatch')
    expect(executions).toBe(1)
  } finally { await rm(root, { recursive: true, force: true }) }
})

for (const definition of CONNECTORS) {
  test(`${definition.id} checks and authorizes the same managed executable and account environment`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'connector account fixture '))
    const invocations: Array<{ command: string, args: string[], env?: Record<string, string> }> = []
    const dependencies: RuntimeDependencies = {
      platform: 'darwin', arch: 'arm64',
      binaryIntegrity: () => 'sha256-' + createHash('sha256').update('binary').digest('hex'),
      readBinary: async () => Buffer.from('binary'),
      download: async () => { throw new Error('Unexpected download') },
      extract: async () => { throw new Error('Unexpected extraction') },
      async run(command, args, options) {
        invocations.push({ command, args, env: options.env })
        return result(definition.id === 'wecom' ? 'authorized' : definition.id === 'feishu'
          ? { ok: true, identity: 'user', verified: true }
          : { success: true, authenticated: true })
      },
    }
    try {
      const installation = managedInstallation(definition, root, dependencies)
      const adapter = createConnectorAdapter(definition, root, dependencies)
      const signal = new AbortController().signal
      expect((await adapter.check(installation, signal)).authenticated).toBe(true)
      await adapter.authenticate(installation, signal, () => {})
      expect((await adapter.check(installation, signal)).authenticated).toBe(true)
      expect(invocations.length).toBeGreaterThanOrEqual(3)
      for (const invocation of invocations) {
        expect(invocation.command).toBe(installation.command)
        expect(invocation.env).toEqual(installation.env)
      }
      if (definition.id === 'dingtalk') {
        expect(installation.env).toEqual({
          DWS_CONFIG_DIR: join(root, 'accounts', 'dingtalk', 'dws'),
          DWS_KEYCHAIN_DIR: join(root, 'accounts', 'dingtalk', 'keychain'),
          DWS_DISABLE_KEYCHAIN: '1',
        })
      } else {
        // Feishu and WeCom deliberately share the desktop user's account.
        expect(installation.env).toEqual({})
      }
    } finally { await rm(root, { recursive: true, force: true }) }
  })
}
