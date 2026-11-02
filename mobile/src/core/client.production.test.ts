import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createSandboxedTestEnvironment,
  removeTestSandbox,
} from '../../../scripts/pr/test-environment'

test('LAN verify agrees with the production H5 handler in an isolated process', () => {
  const sandboxHome = mkdtempSync(join(tmpdir(), 'mobile-h5-contract-'))
  try {
    const env = createSandboxedTestEnvironment(sandboxHome)
    const fakeToken = 'h5_mobile_contract_fixture_only'
    const managedDir = join(env.CLAUDE_CONFIG_DIR, 'cc-haha')
    mkdirSync(managedDir, { recursive: true })
    writeFileSync(
      join(managedDir, 'settings.json'),
      JSON.stringify({
        h5Access: {
          enabled: true,
          token: fakeToken,
          tokenHash: createHash('sha256').update(fakeToken).digest('hex'),
        },
      })
    )
    const clientUrl = new URL('./client.ts', import.meta.url).href
    const handlerUrl = new URL(
      '../../../src/server/api/h5-access.ts',
      import.meta.url
    ).href
    const resultPath = join(sandboxHome, 'contract-result.json')
    const script = `
      import assert from 'node:assert/strict'
      import { writeFileSync, writeSync } from 'node:fs'
      const report = value => writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify(value))
      report({ phase: 'started' })
      try {
      assert.equal(process.env.CLAUDE_CONFIG_DIR, ${JSON.stringify(env.CLAUDE_CONFIG_DIR)})
      assert.equal(process.env.HOME, ${JSON.stringify(sandboxHome)})
      globalThis.fetch = () => { throw new Error('Network is forbidden in the H5 contract test') }
      const { ApiClient } = await import(${JSON.stringify(clientUrl)})
      const { handleH5AccessApi } = await import(${JSON.stringify(handlerUrl)})
      report({ phase: 'imported' })
      const requests = []
      const adapter = async (input, init) => {
        requests.push({ method: init.method, authorization: init.headers.Authorization, body: init.body })
        const url = new URL(input)
        return handleH5AccessApi(new Request(input, init), url, url.pathname.split('/').filter(Boolean))
      }
      const host = { id: 'fixture', name: 'Fixture', url: 'http://127.0.0.1:3456', auth: 'lan' }
      const client = new ApiClient(host, ${JSON.stringify(fakeToken)}, { fetch: adapter })
      assert.deepEqual(await client.verify(), { ok: true })
      assert.deepEqual(requests[0], { method: 'POST', authorization: 'Bearer ' + ${JSON.stringify(fakeToken)}, body: undefined })
      await assert.rejects(new ApiClient(host, 'invalid-fixture-token', { fetch: adapter }).verify(), error => error.status === 401)
      const url = new URL('/api/h5-access/verify', host.url)
      const get = await handleH5AccessApi(new Request(url, { headers: { Authorization: 'Bearer ' + ${JSON.stringify(fakeToken)} } }), url, ['api', 'h5-access', 'verify'])
      assert.equal(get.status, 405, 'GET must not accidentally become the mobile verification contract')
      writeSync(1, 'production H5 contract passed')
      report({ ok: true })
      } catch (error) {
        report({ message: error.message, status: error.status, code: error.code })
        writeSync(2, String(error.stack || error))
        process.exitCode = 1
      }
    `
    const preloadPath = new URL('../../../preload.ts', import.meta.url).pathname
    const result = spawnSync(
      process.execPath,
      ['--no-env-file', '--preload', preloadPath, '-e', script],
      {
        cwd: sandboxHome,
        env: { ...env, NODE_ENV: 'test' },
        encoding: 'utf8',
        timeout: 15000,
      }
    )
    const report = existsSync(resultPath)
      ? readFileSync(resultPath, 'utf8')
      : 'No child report'
    if (result.status !== 0)
      throw new Error(
        `Isolated H5 contract failed (status ${result.status}, signal ${result.signal}): ${report}\n${result.error?.message ?? ''}\n${result.stdout}\n${result.stderr}`
      )
    expect(JSON.parse(report)).toEqual({ ok: true })
  } finally {
    removeTestSandbox(sandboxHome, 'mobile H5 contract')
  }
}, 20000)

test('native LAN WebSocket empty Origin retains real-server authentication and browser CORS', () => {
  const sandboxHome = mkdtempSync(join(tmpdir(), 'mobile-ws-origin-'))
  try {
    const env = createSandboxedTestEnvironment(sandboxHome)
    const fakeToken = 'h5_mobile_socket_fixture_only'
    const managedDir = join(env.CLAUDE_CONFIG_DIR, 'cc-haha')
    mkdirSync(managedDir, { recursive: true })
    writeFileSync(
      join(managedDir, 'settings.json'),
      JSON.stringify({
        h5Access: {
          enabled: true,
          token: fakeToken,
          tokenHash: createHash('sha256').update(fakeToken).digest('hex'),
          allowedOrigins: [],
        },
      })
    )
    const resultPath = join(sandboxHome, 'socket-contract-result.json')
    const connectionUrl = new URL('./connection.ts', import.meta.url).href
    const serverUrl = new URL('../../../src/server/index.ts', import.meta.url)
      .href
    const sessionUrl = new URL(
      '../../../src/server/services/sessionService.ts',
      import.meta.url
    ).href
    const mockCli = new URL(
      '../../../src/server/__tests__/fixtures/mock-sdk-cli.ts',
      import.meta.url
    ).pathname
    const script = `
      import assert from 'node:assert/strict'
      import { writeFileSync, writeSync } from 'node:fs'
      const report = value => writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify(value))
      report({ phase: 'started' })
      let server
      let shutdown
      let socket
      try {
        assert.equal(process.env.HOME, ${JSON.stringify(sandboxHome)})
        const realFetch = globalThis.fetch
        globalThis.fetch = (input, init) => {
          const url = new URL(input instanceof Request ? input.url : String(input))
          assert.equal(url.hostname, '127.0.0.1', 'Public network is forbidden')
          return realFetch(input, init)
        }
        process.env.CLAUDE_CLI_PATH = ${JSON.stringify(mockCli)}
        const { startServer, stopServerRuntimeForShutdown } = await import(${JSON.stringify(serverUrl)})
        shutdown = stopServerRuntimeForShutdown
        const { sessionService } = await import(${JSON.stringify(sessionUrl)})
        const { buildSocketOptions } = await import(${JSON.stringify(connectionUrl)})
        server = startServer(0, '127.0.0.1')
        const created = await sessionService.createSession(process.env.HOME)
        const base = 'http://127.0.0.1:' + server.port
        const host = { id: 'fixture', name: 'Fixture', url: base, auth: 'lan' }
        const options = buildSocketOptions(host, ${JSON.stringify(fakeToken)}, created.sessionId, 'native')
        assert.equal(options.headers.Origin, '', 'Native LAN must suppress RN default Origin')
        // A proxy trace prevents loopback's legitimate local-user exemption;
        // this exercises the same required H5 bearer gate as a remote LAN phone.
        const trace = { 'X-Forwarded-For': '192.168.1.50' }
        async function handshake(headers) {
          const response = await fetch(base + '/ws/' + created.sessionId, { headers: {
            ...trace, ...headers, Upgrade: 'websocket', Connection: 'Upgrade',
            'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version': '13',
          } })
          await response.text()
          return response.status
        }
        assert.equal(await handshake({ Origin: '' }), 401)
        assert.equal(await handshake({ Origin: '', Authorization: 'Bearer wrong-fixture-token' }), 401)
        assert.equal(await handshake({ ...options.headers, Origin: 'http://10.0.2.2:3567' }), 403)
        assert.equal(await handshake({ ...options.headers, Origin: 'https://attacker.invalid' }), 403)
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('WebSocket handshake timed out')), 5000)
          socket = new WebSocket(options.url, { headers: { ...trace, ...options.headers } })
          socket.onopen = () => { clearTimeout(timer); resolve() }
          socket.onerror = () => { clearTimeout(timer); reject(new Error('Authenticated native handshake failed')) }
        })
        const closed = new Promise(resolve => { socket.onclose = resolve })
        socket.close()
        await closed
        report({ ok: true, authenticatedUpgrade: true, missingBearer: 401, invalidBearer: 401, aliasOrigin: 403, hostileOrigin: 403, messagesSent: 0 })
      } catch (error) {
        report({ message: error.message })
        writeSync(2, String(error.stack || error))
        process.exitCode = 1
      } finally {
        socket?.close()
        await shutdown?.()
        await server?.stop(true)
      }
      process.exit(process.exitCode || 0)
    `
    const result = spawnSync(
      process.execPath,
      [
        '--no-env-file',
        '--preload',
        new URL('../../../preload.ts', import.meta.url).pathname,
        '-e',
        script,
      ],
      {
        cwd: sandboxHome,
        env: { ...env, NODE_ENV: 'test' },
        encoding: 'utf8',
        timeout: 15000,
      }
    )
    const report = existsSync(resultPath)
      ? readFileSync(resultPath, 'utf8')
      : 'No child report'
    if (result.status !== 0)
      throw new Error(
        `Isolated WebSocket contract failed (status ${result.status}, signal ${result.signal}): ${report}\n${result.error?.message ?? ''}\n${result.stdout}\n${result.stderr}`
      )
    expect(JSON.parse(report)).toEqual({
      ok: true,
      authenticatedUpgrade: true,
      missingBearer: 401,
      invalidBearer: 401,
      aliasOrigin: 403,
      hostileOrigin: 403,
      messagesSent: 0,
    })
  } finally {
    removeTestSandbox(sandboxHome, 'mobile WebSocket Origin contract')
  }
}, 20000)
