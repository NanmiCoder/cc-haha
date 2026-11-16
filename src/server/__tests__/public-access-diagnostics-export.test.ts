import { expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, connect, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import type { spawn } from 'node:child_process'
import { gunzipSync } from 'node:zlib'
import { PublicAccessManager, PUBLIC_ACCESS_CONSENT_VERSION } from '../../../desktop/electron/services/publicAccess.js'
import { startCloudflareTunnel } from '../../../desktop/electron/services/cloudflareTunnel.js'
import { createPublicAccessDiagnosticWriter } from '../../../desktop/electron/services/publicAccessDiagnostics.js'
import { SystemProxyBridge } from '../../../desktop/electron/services/systemProxyBridge.js'
import { startCloudflareProxyTransport } from '../../../desktop/electron/services/cloudflareProxy.js'
import { DiagnosticsService } from '../services/diagnosticsService.js'
import { resolveRemoteAccessProxy } from '../services/remoteAccessConnectivity.js'

// Exercise the shipped connector and CONNECT bridge against a loopback rejection,
// substituting only the external cloudflared process and saved network settings.
test('a CONNECT failure reaches the exported diagnostic bundle with the connector and attempt context', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'connection-host-export-'))
  const previousConfig = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = directory
  const service = new DiagnosticsService()
  const sockets = new Set<Socket>()
  const proxy = createServer(socket => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.once('data', () => socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n'))
  })
  let manager: PublicAccessManager | undefined
  try {
    await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve))
    const address = proxy.address()
    if (!address || typeof address === 'string') throw new Error('Missing proxy port')
    const proxyUrl = `http://export-fixture-user:export-fixture-password@127.0.0.1:${address.port}`
    const token = 'eyJhIjoiZmFrZS1maXh0dXJlLXRva2VuIiwicyI6ImZha2UifQ=='
    const binaryPath = join(directory, 'cloudflared')
    await writeFile(binaryPath, 'fixture process only', { mode: 0o700 })
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(), stderr: new PassThrough(), pid: 12345,
      kill: () => { queueMicrotask(() => child.emit('exit', 0, null)); return true },
    })
    manager = new PublicAccessManager({
      directory: join(directory, 'connection'),
      onDiagnostic: createPublicAccessDiagnosticWriter(service.getElectronHostPath()),
      backend: { async request<T>(route, _method, body, context) {
        if (route === '/enable') return { port: (body as { port: number }).port } as T
        if (route === '/network') return await resolveRemoteAccessProxy({ ...context,
          settings: async () => ({ aiRequestTimeoutMs: 30000, proxy: { mode: 'manual', url: proxyUrl } }),
          recordDiagnostic: input => service.recordEvent(input),
        }) as T
        return {} as T
      } },
      startTunnel: options => startCloudflareTunnel(options, {
        binaryPath, temporaryDirectory: directory, timeoutMs: 1000,
        spawn: ((_binary, args: string[]) => {
          const edge = args[args.indexOf('--edge') + 1]!
          setImmediate(() => {
            const [host, port] = edge.split(':')
            const socket = connect({ host, port: Number(port) })
            sockets.add(socket)
            socket.on('error', () => {})
            socket.on('close', () => {
              sockets.delete(socket)
              child.stderr.write(`Cloudflare edge connection failed; token=${token}\n`)
              child.emit('exit', 1, null)
            })
          })
          return child
        }) as unknown as typeof spawn,
      }),
    })
    await manager.configure({ mode: 'named', customUrl: '', localPort: 17463, tunnelToken: token })
    const status = await manager.start(PUBLIC_ACCESS_CONSENT_VERSION)
    expect(status).toMatchObject({ state: 'reconnecting', error: 'proxy' })
    await manager.stop()
    const archive = await readFile((await service.exportBundle()).path)
    const contents = gunzipSync(archive).toString()
    for (const evidence of ['proxy_connect', 'http_connect_rejected', '407', '7844', 'connector_exit', 'tunnel_registration', 'tunnel_start']) expect(contents).toContain(evidence)
    const hostLog = await readFile(service.getElectronHostPath(), 'utf8')
    const event = hostLog.split('\n').filter(Boolean).map(line => JSON.parse(line.slice('[public-access] '.length))).find(event => event.stage === 'proxy_connect')
    const serverEvents = await service.readRecentEvents()
    expect(serverEvents.find(event => event.type === 'remote_access_proxy_resolution' && (event.details as { outcome?: string }).outcome === 'succeeded')?.details).toMatchObject({ attemptId: event.attemptId, proxyMode: 'manual' })
    for (const secret of ['export-fixture-user', 'export-fixture-password', token]) {
      expect(contents).not.toContain(secret)
      expect(hostLog).not.toContain(secret)
    }
  } finally {
    await manager?.dispose()
    for (const socket of sockets) socket.destroy()
    await new Promise<void>(resolve => proxy.close(() => resolve()))
    await service.drainForMigration()
    if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previousConfig
    await rm(directory, { recursive: true, force: true })
  }
})

test('exports the system proxy failure hidden behind the connector CONNECT 502', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'system-proxy-export-'))
  const previousConfig = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = directory
  const service = new DiagnosticsService()
  const onDiagnostic = createPublicAccessDiagnosticWriter(service.getElectronHostPath())
  const bridge = new SystemProxyBridge(async () => {
    throw Object.assign(new Error('PAC lookup failed token=private-pac-fixture'), { code: 'EAI_AGAIN' })
  }, onDiagnostic)
  let transport: Awaited<ReturnType<typeof startCloudflareProxyTransport>> | undefined
  let socket: Socket | undefined
  try {
    transport = await startCloudflareProxyTransport(await bridge.start(), { onDiagnostic })
    const [host, port] = transport.edgeAddresses[0]!.split(':')
    await new Promise<void>((resolve, reject) => {
      socket = connect({ host, port: Number(port) })
      socket.once('error', reject)
      socket.once('close', () => resolve())
    })
    const archive = gunzipSync(await readFile((await service.exportBundle()).path)).toString()
    for (const evidence of ['system_proxy_resolution', 'EAI_AGAIN', 'PAC lookup failed', 'proxy_connect', '502', '7844']) expect(archive).toContain(evidence)
    expect(archive).not.toContain('private-pac-fixture')
  } finally {
    socket?.destroy()
    await transport?.stop()
    await bridge.stop()
    await service.drainForMigration()
    if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previousConfig
    await rm(directory, { recursive: true, force: true })
  }
})
