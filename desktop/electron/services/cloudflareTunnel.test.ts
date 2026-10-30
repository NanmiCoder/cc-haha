// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { type spawn } from 'node:child_process'
import {
  CloudflareTunnelError,
  cloudflareProcessEnvironment,
  resolveBundledCloudflared,
  startCloudflareTunnel,
  type CloudflareTunnel,
  type CloudflareTunnelDependencies,
  type CloudflareTunnelOptions,
} from './cloudflareTunnel'

class FakeChild extends EventEmitter {
  stdout = new PassThrough()
  stderr = new PassThrough()
  pid: number | undefined = 12345
  kill = vi.fn((_signal?: NodeJS.Signals) => {
    queueMicrotask(() => this.emit('exit', 0, null))
    return true
  })
}

const directories: string[] = []
const children: FakeChild[] = []
const tunnels: CloudflareTunnel[] = []
const controllers: AbortController[] = []

afterEach(async () => {
  controllers.splice(0).forEach(controller => controller.abort())
  children.splice(0).forEach(child => child.emit('exit', 0, null))
  await Promise.allSettled(tunnels.splice(0).map(tunnel => tunnel.stop()))
  directories.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true }))
})

function fixture(dependencies: Partial<CloudflareTunnelDependencies> = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'cloudflare-runtime-test-'))
  directories.push(directory)
  const binaryPath = path.join(directory, 'cloudflared')
  writeFileSync(binaryPath, 'fake binary never executed', { mode: 0o700 })
  const child = new FakeChild()
  children.push(child)
  const spawnFn = vi.fn(() => child)
  const controller = new AbortController()
  controllers.push(controller)
  const start = (options: Partial<CloudflareTunnelOptions> = {}) => {
    const pending = startCloudflareTunnel({ mode: 'quick', localPort: 17463, signal: controller.signal, ...options }, {
      binaryPath,
      temporaryDirectory: directory,
      spawn: spawnFn as unknown as typeof spawn,
      env: { PATH: '/fixture/bin' },
      timeoutMs: 1_000,
      stopTimeoutMs: 10,
      ...dependencies,
    })
    void pending.then(tunnel => { tunnels.push(tunnel) }, () => {})
    return pending
  }
  const spawned = async () => {
    const deadline = Date.now() + 5_000
    while (!spawnFn.mock.calls.length && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 1))
    }
    expect(spawnFn).toHaveBeenCalledTimes(1)
  }
  return { directory, binaryPath, child, spawnFn, controller, start, spawned }
}

describe('bundled Cloudflare connector', () => {
  it('resolves the same target-specific packaged binary on every supported platform', () => {
    expect(resolveBundledCloudflared('/desktop', 'darwin', 'arm64')).toBe('/desktop/src-tauri/binaries/cloudflared-aarch64-apple-darwin')
    expect(resolveBundledCloudflared('/desktop', 'linux', 'x64')).toBe('/desktop/src-tauri/binaries/cloudflared-x86_64-unknown-linux-gnu')
    expect(resolveBundledCloudflared('/desktop', 'win32', 'x64')).toBe('/desktop/src-tauri/binaries/cloudflared-x86_64-pc-windows-msvc.exe')
    expect(resolveBundledCloudflared('/Resources/app.asar', 'darwin', 'x64')).toBe('/Resources/app.asar.unpacked/src-tauri/binaries/cloudflared-x86_64-apple-darwin')
  })

  it('does not inherit another tunnel, token, proxy, or user home', () => {
    const original = {
      HOME: '/real-user', USERPROFILE: '/real-user', PATH: '/fixture/bin',
      TUNNEL_TOKEN: 'saved-token', TUNNEL_ORIGIN_CERT: '/real-user/cert.pem',
      TUNNEL_URL: 'http://wrong-service', TUNNEL_LOGFILE: '/real-user/tunnel.log',
      HTTP_PROXY: 'http://wrong-proxy', https_proxy: 'http://wrong-proxy',
      ALL_PROXY: 'socks5://wrong-proxy', no_proxy: '*',
    }
    const env = cloudflareProcessEnvironment(original, '/owned-private-directory', 'new-token')
    expect(env).toEqual({ HOME: '/owned-private-directory', USERPROFILE: '/owned-private-directory', XDG_CONFIG_HOME: '/owned-private-directory', PATH: '/fixture/bin', NO_AUTOUPDATE: 'true', TUNNEL_TOKEN: 'new-token' })
    expect(original.TUNNEL_TOKEN).toBe('saved-token')
    expect(cloudflareProcessEnvironment(original, '/owned-private-directory').TUNNEL_TOKEN).toBeUndefined()
  })

  it('fails clearly when the bundled binary is missing instead of downloading during connection', async () => {
    await expect(startCloudflareTunnel({ mode: 'quick', localPort: 17463 }, { binaryPath: '/fixture/does-not-exist' })).rejects.toMatchObject({ code: 'runtime' })
  })
})

describe('Quick Tunnel readiness', () => {
  it('waits for both the actual public address and an edge connection before reporting ready', async () => {
    const f = fixture()
    const onPhase = vi.fn()
    const pending = f.start({ onPhase })
    await f.spawned()
    const settled = vi.fn()
    void pending.then(settled)
    f.child.stderr.write('Requesting tunnel from https://api.trycloudflare.com\n')
    f.child.stdout.write('https://real-address.trycloudflare.com\n')
    await Promise.resolve()
    expect(settled).not.toHaveBeenCalled()
    expect(onPhase).not.toHaveBeenCalledWith('ready')
    f.child.stderr.write('{"message":"Registered tunnel connection","connIndex":0}\n')
    const tunnel = await pending
    expect(tunnel.url).toBe('https://real-address.trycloudflare.com')
    expect(onPhase.mock.calls.map(([value]) => value)).toEqual(['starting', 'registering', 'ready'])
    const [binary, args, processOptions] = f.spawnFn.mock.calls[0] as unknown as [string, string[], { cwd: string, env: NodeJS.ProcessEnv, windowsHide: boolean }]
    expect(binary).toBe(f.binaryPath)
    expect(args).toContain('--url')
    expect(args).toContain('http://127.0.0.1:17463')
    expect(args.slice(0, 1)).toEqual(['--no-autoupdate'])
    expect(args[args.indexOf('--protocol') + 1]).toBe('http2')
    expect(args[args.indexOf('--metrics') + 1]).toBe('127.0.0.1:0')
    const config = args[args.indexOf('--config') + 1]!
    expect(readFileSync(config, 'utf8')).toBe('{}\n')
    expect(processOptions.env.HOME).toBe(processOptions.cwd)
    expect(processOptions.windowsHide).toBe(true)
    expect(config.startsWith(f.directory)).toBe(true)
    await tunnel.stop()
    expect(existsSync(config)).toBe(false)
  })

  it('also handles registration arriving before a URL and logs split across chunks', async () => {
    const f = fixture()
    const pending = f.start()
    await f.spawned()
    f.child.stderr.write('Registered tunnel ')
    f.child.stderr.write('connection connIndex=0\nhttps://abc.')
    f.child.stderr.write('trycloudflare.com\n')
    expect((await pending).url).toBe('https://abc.trycloudflare.com')
  })

  it('does not treat the registration API or a lookalike domain as its public address', async () => {
    const f = fixture({ timeoutMs: 20 })
    const pending = f.start()
    const outcome = pending.catch((error: unknown) => error)
    await f.spawned()
    f.child.stderr.write('https://api.trycloudflare.com\nhttps://abc.trycloudflare.com.evil.test\nRegistered tunnel connection\n')
    expect(await outcome).toMatchObject({ code: 'network' })
    expect(f.child.kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('does not return a URL when no edge connection can be established', async () => {
    const f = fixture({ timeoutMs: 20 })
    const pending = f.start()
    const outcome = pending.catch((error: unknown) => error)
    await f.spawned()
    f.child.stderr.write('https://abc.trycloudflare.com\n')
    expect(await outcome).toMatchObject({ code: 'network' })
  })
})

describe('named tunnels and proxy routing', () => {
  const token = 'eyJ-fake-credential-only-for-a-test'

  it('uses the configured HTTPS origin and keeps the token out of process arguments and errors', async () => {
    const f = fixture()
    const pending = f.start({ mode: 'named', token, publicUrl: 'https://Pocket.Example.com/' })
    await f.spawned()
    f.child.stderr.write('Registered tunnel connection\n')
    expect((await pending).url).toBe('https://pocket.example.com')
    const [, args, processOptions] = f.spawnFn.mock.calls[0] as unknown as [string, string[], { env: NodeJS.ProcessEnv }]
    expect(args.at(-1)).toBe('run')
    expect(args).not.toContain('--url')
    expect(args.join(' ')).not.toContain(token)
    expect(processOptions.env.TUNNEL_TOKEN).toBe(token)
  })

  it.each([
    { token: '', publicUrl: 'https://pocket.example.com' },
    { token: 'cloudflared service install mytoken', publicUrl: 'https://pocket.example.com' },
    { token, publicUrl: 'http://pocket.example.com' },
    { token, publicUrl: 'https://pocket.example.com/path' },
  ])('rejects incomplete fixed-domain configuration before starting a process: %j', async options => {
    const f = fixture()
    await expect(f.start({ mode: 'named', ...options })).rejects.toMatchObject({ code: 'configuration' })
    expect(f.spawnFn).not.toHaveBeenCalled()
  })

  it.each(['quick', 'named'] as const)('routes %s through the private proxy transport and releases it with the child', async mode => {
    const transport = { edgeAddresses: ['127.0.0.1:18301', '127.0.0.1:18302'], quickServiceUrl: 'http://127.0.0.1:18303/private-path', stop: vi.fn(async () => {}) }
    const startProxyTransport = vi.fn(async () => transport)
    const f = fixture({ startProxyTransport })
    const pending = f.start({ mode, token, publicUrl: 'https://pocket.example.com', proxyUrl: 'http://127.0.0.1:7890' })
    await f.spawned()
    f.child.stderr.write('https://abc.trycloudflare.com\nRegistered tunnel connection\n')
    const tunnel = await pending
    expect(startProxyTransport).toHaveBeenCalledWith('http://127.0.0.1:7890', { signal: f.controller.signal })
    const [, args] = f.spawnFn.mock.calls[0] as unknown as [string, string[]]
    expect(args[args.indexOf('--protocol') + 1]).toBe('http2')
    expect(args).toContain('--no-prechecks')
    expect(args.filter(arg => arg === '--edge')).toHaveLength(2)
    expect(args).toContain('127.0.0.1:18301')
    expect(args.includes('--quick-service')).toBe(mode === 'quick')
    if (mode === 'quick') expect(args).toContain(transport.quickServiceUrl)
    await tunnel.stop()
    expect(transport.stop).toHaveBeenCalledTimes(1)
  })

  it('does not fall back to a direct connection when the configured proxy fails', async () => {
    const startProxyTransport = vi.fn(async () => { throw new Error('proxy-user:proxy-password') })
    const f = fixture({ startProxyTransport })
    const pending = f.start({ proxyUrl: 'http://proxy-user:proxy-password@127.0.0.1:7890' })
    await expect(pending).rejects.toMatchObject({ code: 'proxy', message: 'Cloudflare could not use the configured network proxy' })
    expect(f.spawnFn).not.toHaveBeenCalled()
  })

  it('cleans up an invalid proxy transport rather than accepting an external injection endpoint', async () => {
    const transport = { edgeAddresses: ['evil.test:7844'], quickServiceUrl: 'http://127.0.0.1:18303/private-path', stop: vi.fn(async () => {}) }
    const f = fixture({ startProxyTransport: vi.fn(async () => transport) })
    await expect(f.start({ proxyUrl: 'http://127.0.0.1:7890' })).rejects.toMatchObject({ code: 'proxy' })
    expect(transport.stop).toHaveBeenCalledTimes(1)
    expect(f.spawnFn).not.toHaveBeenCalled()
  })
})

describe('connector cancellation and exit', () => {
  it('cancels a pending start and confirms the child has exited', async () => {
    const f = fixture()
    const pending = f.start()
    const outcome = pending.catch((error: unknown) => error)
    await f.spawned()
    f.controller.abort()
    expect(await outcome).toMatchObject({ name: 'AbortError' })
    expect(f.child.kill).toHaveBeenCalledTimes(1)
  })

  it('does not start a connector when already cancelled', async () => {
    const f = fixture()
    f.controller.abort()
    await expect(f.start()).rejects.toMatchObject({ name: 'AbortError' })
    expect(f.spawnFn).not.toHaveBeenCalled()
  })

  it('surfaces spawn errors without exposing child output or waiting for a nonexistent process', async () => {
    const f = fixture()
    const pending = f.start()
    const outcome = pending.catch((error: unknown) => error)
    await f.spawned()
    f.child.pid = undefined
    f.child.emit('error', new Error('sensitive process detail'))
    expect(await outcome).toMatchObject({ code: 'runtime' })
    expect(f.child.kill).not.toHaveBeenCalled()
  })

  it('classifies invalid credentials as configuration errors without echoing the token', async () => {
    const f = fixture()
    const pending = f.start({ mode: 'named', token: 'fake-base64-token-for-this-test', publicUrl: 'https://pocket.example.com' })
    const outcome = pending.catch((error: unknown) => error)
    await f.spawned()
    f.child.stderr.write('Provided Tunnel token is not valid: fake-base64-token-for-this-test\n')
    f.child.emit('exit', 1, null)
    expect(await outcome).toMatchObject({ code: 'configuration' })
  })

  it('notifies both current and late subscribers about an unexpected process exit', async () => {
    const f = fixture()
    const pending = f.start()
    await f.spawned()
    f.child.stderr.write('https://abc.trycloudflare.com\nRegistered tunnel connection\n')
    const tunnel = await pending
    const observer = vi.fn()
    const cancelledObserver = vi.fn()
    tunnel.onExit(observer)
    tunnel.onExit(cancelledObserver)()
    f.child.emit('exit', 7, null)
    expect(observer).toHaveBeenCalledTimes(1)
    expect(observer).toHaveBeenCalledWith({ code: 7, signal: null })
    expect(cancelledObserver).not.toHaveBeenCalled()
    const lateObserver = vi.fn()
    tunnel.onExit(lateObserver)
    await Promise.resolve()
    expect(lateObserver).toHaveBeenCalledTimes(1)
    expect(lateObserver).toHaveBeenCalledWith({ code: 7, signal: null })
  })

  it('does not report an intentional close as an unexpected disconnect and escalates stuck children', async () => {
    const f = fixture({ stopTimeoutMs: 5 })
    f.child.kill.mockImplementation(signal => {
      if (signal === 'SIGKILL') queueMicrotask(() => f.child.emit('exit', null, 'SIGKILL'))
      return true
    })
    const pending = f.start()
    await f.spawned()
    f.child.stderr.write('https://abc.trycloudflare.com\nRegistered tunnel connection\n')
    const tunnel = await pending
    const observer = vi.fn()
    tunnel.onExit(observer)
    await Promise.all([tunnel.stop(), tunnel.stop()])
    expect(f.child.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']])
    expect(observer).not.toHaveBeenCalled()
  })

  it('fails closed when even forced termination is not confirmed', async () => {
    const f = fixture({ stopTimeoutMs: 2 })
    f.child.kill.mockImplementation(() => true)
    const pending = f.start()
    await f.spawned()
    f.child.stderr.write('https://abc.trycloudflare.com\nRegistered tunnel connection\n')
    const tunnel = await pending
    await expect(tunnel.stop()).rejects.toBeInstanceOf(CloudflareTunnelError)
    expect(f.child.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']])
  })

  it('can confirm a delayed exit after an earlier shutdown attempt timed out', async () => {
    const f = fixture({ stopTimeoutMs: 2 })
    f.child.kill.mockImplementation(() => true)
    const pending = f.start()
    await f.spawned()
    f.child.stderr.write('https://abc.trycloudflare.com\nRegistered tunnel connection\n')
    const tunnel = await pending
    await expect(tunnel.stop()).rejects.toBeInstanceOf(CloudflareTunnelError)
    f.child.emit('exit', null, 'SIGKILL')
    await expect(tunnel.stop()).resolves.toBeUndefined()
  })

  it('cuts proxy connectivity even when process termination is not yet confirmed', async () => {
    const transport = { edgeAddresses: ['127.0.0.1:18301'], quickServiceUrl: 'http://127.0.0.1:18303/private-path', stop: vi.fn(async () => {}) }
    const f = fixture({ stopTimeoutMs: 2, startProxyTransport: vi.fn(async () => transport) })
    f.child.kill.mockImplementation(() => true)
    const pending = f.start({ proxyUrl: 'http://127.0.0.1:7890' })
    await f.spawned()
    f.child.stderr.write('https://abc.trycloudflare.com\nRegistered tunnel connection\n')
    const tunnel = await pending
    await expect(tunnel.stop()).rejects.toBeInstanceOf(CloudflareTunnelError)
    expect(transport.stop).toHaveBeenCalledTimes(1)
    f.child.emit('exit', null, 'SIGKILL')
    await tunnel.stop()
    expect(transport.stop).toHaveBeenCalledTimes(1)
  })

  it('retains a recovery stop handle when startup cancellation cannot confirm process termination', async () => {
    const f = fixture({ stopTimeoutMs: 2 })
    f.child.kill.mockImplementation(() => true)
    const pending = f.start()
    const outcome = pending.catch((error: unknown) => error)
    await f.spawned()
    f.controller.abort()
    const error = await outcome
    expect(error).toBeInstanceOf(CloudflareTunnelError)
    expect((error as CloudflareTunnelError).code).toBe('runtime')
    expect(typeof (error as CloudflareTunnelError).retryStop).toBe('function')
    f.child.emit('exit', null, 'SIGKILL')
    await expect((error as CloudflareTunnelError).retryStop!()).resolves.toBeUndefined()
  })
})
