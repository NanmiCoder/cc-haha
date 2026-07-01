import { describe, expect, it, vi } from 'vitest'
import net from 'node:net'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import {
  buildSidecarEnv,
  createAdapterPlan,
  createServerPlan,
  createTunnelPlan,
  httpToWebSocketUrl,
  killSidecar,
  mergeProxyEnv,
  parseH5FixedPort,
  preferredServerPorts,
  proxyUrlFromElectronProxyRules,
  pushStartupLog,
  readH5FixedPort,
  readLastServerPort,
  reserveLocalPort,
  reserveServerPort,
  resolveCloudflaredPath,
  resolveHostTriple,
  spawnSidecar,
  waitForTunnelUrl,
  windowsPowerShellOverride,
  writeLastServerPort,
  type SidecarChild,
} from './sidecarManager'

function fakeChild(pid = 4321) {
  return { pid, kill: vi.fn() } as unknown as SidecarChild & { kill: ReturnType<typeof vi.fn> }
}

describe('Electron sidecar manager', () => {
  it('maps host platform to existing sidecar target triples', () => {
    expect(resolveHostTriple('darwin', 'arm64')).toBe('aarch64-apple-darwin')
    expect(resolveHostTriple('darwin', 'x64')).toBe('x86_64-apple-darwin')
    expect(resolveHostTriple('win32', 'x64')).toBe('x86_64-pc-windows-msvc')
    expect(resolveHostTriple('linux', 'arm64')).toBe('aarch64-unknown-linux-gnu')
  })

  it('builds server sidecar args without changing the REST/WebSocket boundary', () => {
    const plan = createServerPlan({
      desktopRoot: '/app/desktop',
      appRoot: '/app',
      port: 49321,
      env: {},
    })

    expect(plan.args).toEqual([
      'server',
      '--app-root',
      '/app',
      '--host',
      '0.0.0.0',
      '--port',
      '49321',
    ])
    expect(plan.env.CLAUDE_H5_AUTO_PUBLIC_URL).toBe('1')
    expect(plan.env.CLAUDE_H5_DIST_DIR).toBe(path.join('/app/desktop', 'dist'))
  })

  it('can keep sidecar binaries and H5 assets unpacked while pointing app-root at app.asar', () => {
    const plan = createServerPlan({
      desktopRoot: '/Applications/App.app/Contents/Resources/app.asar.unpacked',
      appRoot: '/Applications/App.app/Contents/Resources/app.asar',
      h5DistDir: '/Applications/App.app/Contents/Resources/app.asar.unpacked/dist',
      port: 49321,
      env: {},
    })

    expect(plan.command).toContain('/Applications/App.app/Contents/Resources/app.asar.unpacked/src-tauri/binaries/claude-sidecar-')
    expect(plan.args).toContain('/Applications/App.app/Contents/Resources/app.asar')
    expect(plan.env.CLAUDE_H5_DIST_DIR).toBe('/Applications/App.app/Contents/Resources/app.asar.unpacked/dist')
  })

  it('passes portable config and adapter server URL through the sidecar env', () => {
    const configDir = mkdtempSync(path.join(tmpdir(), 'cc-haha-config-'))
    try {
      const env = buildSidecarEnv({ CLAUDE_CONFIG_DIR: configDir }, '/app/dist', '/app/desktop')
      expect(env.CLAUDE_CONFIG_DIR).toBe(configDir)
      expect(env.XDG_CACHE_HOME).toBe(path.join(configDir, 'Cache'))
      expect(env.CLAUDE_CODE_PLUGIN_SEED_DIR).toBe(path.join('/app/desktop', 'plugin-seed'))

      const adapter = createAdapterPlan({
        desktopRoot: '/app/desktop',
        appRoot: '/app',
        serverUrl: 'http://127.0.0.1:4567',
        flag: '--telegram',
        env: { CLAUDE_CONFIG_DIR: configDir },
      })
      expect(adapter.env.ADAPTER_SERVER_URL).toBe('ws://127.0.0.1:4567')
      expect(adapter.args).toEqual(['adapters', '--app-root', '/app', '--telegram'])

      const whatsappAdapter = createAdapterPlan({
        desktopRoot: '/app/desktop',
        appRoot: '/app',
        serverUrl: 'http://127.0.0.1:4567',
        flag: '--whatsapp',
        env: { CLAUDE_CONFIG_DIR: configDir },
      })
      expect(whatsappAdapter.args).toEqual(['adapters', '--app-root', '/app', '--whatsapp'])
    } finally {
      rmSync(configDir, { recursive: true, force: true })
    }
  })

  it('converts Electron system proxy rules into sidecar proxy env', () => {
    expect(proxyUrlFromElectronProxyRules('DIRECT')).toBeUndefined()
    expect(proxyUrlFromElectronProxyRules('SOCKS5 127.0.0.1:7891; DIRECT')).toBeUndefined()
    expect(proxyUrlFromElectronProxyRules('PROXY 127.0.0.1:7897; DIRECT')).toBe('http://127.0.0.1:7897')
    expect(proxyUrlFromElectronProxyRules('HTTPS proxy.example:8443; DIRECT')).toBe('https://proxy.example:8443')

    const env = mergeProxyEnv({}, 'http://127.0.0.1:7897')
    expect(env.HTTP_PROXY).toBe('http://127.0.0.1:7897')
    expect(env.HTTPS_PROXY).toBe('http://127.0.0.1:7897')
    expect(env.http_proxy).toBe('http://127.0.0.1:7897')
    expect(env.https_proxy).toBe('http://127.0.0.1:7897')
    expect(env.NO_PROXY).toContain('127.0.0.1')
  })

  it('does not override explicit sidecar proxy environment', () => {
    const env = mergeProxyEnv(
      { HTTPS_PROXY: 'http://manual.example:8080' },
      'http://system.example:8080',
    )

    expect(env).toEqual({ HTTPS_PROXY: 'http://manual.example:8080' })
  })

  it('keeps startup logs bounded', () => {
    const logs: string[] = []
    for (let index = 0; index < 85; index++) {
      pushStartupLog(logs, `line ${index}`)
    }
    expect(logs).toHaveLength(80)
    expect(logs[0]).toBe('line 5')
  })

  it('maps http urls to adapter websocket urls', () => {
    expect(httpToWebSocketUrl('http://127.0.0.1:3456')).toBe('ws://127.0.0.1:3456')
    expect(httpToWebSocketUrl('https://example.com')).toBe('wss://example.com')
  })

  it('kills non-Windows sidecars with a signal', () => {
    const child = fakeChild()
    const spawnAsync = vi.fn()
    const spawnSyncFn = vi.fn()
    killSidecar(child, false, { platform: 'darwin', spawnAsync: spawnAsync as never, spawnSyncFn: spawnSyncFn as never })
    expect(child.kill).toHaveBeenCalledTimes(1)
    expect(spawnAsync).not.toHaveBeenCalled()
    expect(spawnSyncFn).not.toHaveBeenCalled()
  })

  it('uses async taskkill on Windows by default', () => {
    const child = fakeChild(777)
    const spawnAsync = vi.fn()
    const spawnSyncFn = vi.fn()
    killSidecar(child, false, { platform: 'win32', spawnAsync: spawnAsync as never, spawnSyncFn: spawnSyncFn as never })
    expect(spawnAsync).toHaveBeenCalledWith('taskkill', ['/F', '/T', '/PID', '777'], { stdio: 'ignore', windowsHide: true })
    expect(spawnSyncFn).not.toHaveBeenCalled()
    expect(child.kill).not.toHaveBeenCalled()
  })

  it('uses synchronous taskkill on Windows during shutdown to avoid orphaned sidecars', () => {
    const child = fakeChild(777)
    const spawnAsync = vi.fn()
    const spawnSyncFn = vi.fn()
    killSidecar(child, true, { platform: 'win32', spawnAsync: spawnAsync as never, spawnSyncFn: spawnSyncFn as never })
    expect(spawnSyncFn).toHaveBeenCalledWith('taskkill', ['/F', '/T', '/PID', '777'], { stdio: 'ignore', windowsHide: true })
    expect(spawnAsync).not.toHaveBeenCalled()
  })

  it('hides Windows console windows when launching sidecars', () => {
    const spawned = {} as SidecarChild
    const spawnFn = vi.fn(() => spawned)
    const existsSyncFn = vi.fn(() => true)
    const plan = {
      command: '/app/desktop/src-tauri/binaries/claude-sidecar-x86_64-pc-windows-msvc.exe',
      args: ['server', '--port', '49321'],
      env: { CLAUDE_H5_AUTO_PUBLIC_URL: '1' },
    }

    expect(spawnSidecar(plan, { existsSyncFn, spawnFn: spawnFn as never })).toBe(spawned)
    expect(existsSyncFn).toHaveBeenCalledWith(plan.command)
    expect(spawnFn).toHaveBeenCalledWith(plan.command, plan.args, {
      env: plan.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
  })

  it('forwards a PowerShell shell choice to the sidecar only on Windows', () => {
    expect(windowsPowerShellOverride('pwsh.exe', 'win32')).toBe('pwsh.exe')
    expect(windowsPowerShellOverride('powershell.exe', 'win32')).toBe('powershell.exe')
    expect(windowsPowerShellOverride('C:\\tools\\PowerShell\\pwsh.exe', 'win32')).toBe('C:\\tools\\PowerShell\\pwsh.exe')
    // non-PowerShell selections must not be reported as a PowerShell override
    expect(windowsPowerShellOverride('cmd.exe', 'win32')).toBeNull()
    expect(windowsPowerShellOverride('C:\\bin\\bash.exe', 'win32')).toBeNull()
    expect(windowsPowerShellOverride(null, 'win32')).toBeNull()
    // never applies off Windows
    expect(windowsPowerShellOverride('pwsh', 'darwin')).toBeNull()
    expect(windowsPowerShellOverride('powershell.exe', 'linux')).toBeNull()
  })

  it('parses only in-range integer h5Access.fixedPort values', () => {
    expect(parseH5FixedPort('{"h5Access":{"fixedPort":28670}}')).toBe(28670)
    expect(parseH5FixedPort('{"h5Access":{"fixedPort":80}}')).toBeNull()
    expect(parseH5FixedPort('{"h5Access":{"fixedPort":70000}}')).toBeNull()
    expect(parseH5FixedPort('{"h5Access":{"fixedPort":"3456"}}')).toBeNull()
    expect(parseH5FixedPort('{"h5Access":{"fixedPort":null}}')).toBeNull()
    expect(parseH5FixedPort('{"h5Access":{}}')).toBeNull()
    expect(parseH5FixedPort('{}')).toBeNull()
    expect(parseH5FixedPort('not json')).toBeNull()
  })

  it('persists and prioritizes preferred server ports from the config dir', () => {
    const configDir = mkdtempSync(path.join(tmpdir(), 'cchh-server-state-'))
    const env = { CLAUDE_CONFIG_DIR: configDir } as NodeJS.ProcessEnv
    try {
      // Nothing stored yet: no preferred ports.
      expect(preferredServerPorts(env)).toEqual([])

      // Sticky port from the previous run.
      writeLastServerPort(50123, env)
      expect(readLastServerPort(env)).toBe(50123)
      expect(preferredServerPorts(env)).toEqual([50123])

      // An explicit fixed port wins over the sticky port.
      mkdirSync(path.join(configDir, 'cc-haha'), { recursive: true })
      writeFileSync(
        path.join(configDir, 'cc-haha', 'settings.json'),
        JSON.stringify({ h5Access: { fixedPort: 28670 } }),
        'utf-8',
      )
      expect(readH5FixedPort(env)).toBe(28670)
      expect(preferredServerPorts(env)).toEqual([28670, 50123])

      // Identical fixed and sticky ports are not duplicated.
      writeLastServerPort(28670, env)
      expect(preferredServerPorts(env)).toEqual([28670])
    } finally {
      rmSync(configDir, { recursive: true, force: true })
    }
  })

  it('reserves a free preferred port and falls back when it is taken', async () => {
    // Reserve a random free port, verify preference picks it while free.
    const freePort = await reserveLocalPort('127.0.0.1')
    await expect(reserveServerPort('127.0.0.1', [freePort])).resolves.toBe(freePort)

    // Occupy it and verify the fallback hands out a different port.
    const blocker = net.createServer()
    await new Promise<void>((resolve, reject) => {
      blocker.once('error', reject)
      blocker.listen(freePort, '127.0.0.1', () => resolve())
    })
    try {
      const fallback = await reserveServerPort('127.0.0.1', [freePort])
      expect(fallback).not.toBe(freePort)
    } finally {
      await new Promise<void>(resolve => blocker.close(() => resolve()))
    }

    // Invalid entries are skipped without throwing.
    await expect(reserveServerPort('127.0.0.1', [0, -1, 1.5, 70000])).resolves.toBeGreaterThan(0)
  })

  it('builds a quick tunnel plan pointing at the local server port', () => {
    const plan = createTunnelPlan({
      cloudflaredPath: '/usr/local/bin/cloudflared',
      port: 28670,
      mode: 'quick',
      env: {},
    })
    expect(plan.command).toBe('/usr/local/bin/cloudflared')
    expect(plan.args).toEqual([
      'tunnel',
      '--no-autoupdate',
      '--url',
      'http://127.0.0.1:28670',
    ])
  })

  it('builds a named tunnel plan using the Cloudflare token', () => {
    const plan = createTunnelPlan({
      cloudflaredPath: 'cloudflared.exe',
      port: 28670,
      mode: 'named',
      token: 'cf-token-123',
      env: {},
    })
    expect(plan.args).toEqual([
      'tunnel',
      '--no-autoupdate',
      'run',
      '--token',
      'cf-token-123',
    ])
  })

  it('rejects a named tunnel plan without a token', () => {
    expect(() => createTunnelPlan({
      cloudflaredPath: 'cloudflared',
      port: 28670,
      mode: 'named',
      env: {},
    })).toThrow(/token is required/i)
  })

  it('resolves an explicit cloudflared override only when it exists', () => {
    expect(resolveCloudflaredPath({ CLOUDFLARED_PATH: '/opt/cf' }, {
      existsSyncFn: ((p: string) => p === '/opt/cf') as typeof import('node:fs').existsSync,
      platform: 'linux',
    })).toBe('/opt/cf')

    expect(resolveCloudflaredPath({ CLOUDFLARED_PATH: '/missing' }, {
      existsSyncFn: (() => false) as typeof import('node:fs').existsSync,
      platform: 'linux',
    })).toBeNull()
  })

  it('falls back to a bare cloudflared command name when no install path matches', () => {
    expect(resolveCloudflaredPath({}, {
      existsSyncFn: (() => false) as typeof import('node:fs').existsSync,
      platform: 'win32',
    })).toBe('cloudflared.exe')
    expect(resolveCloudflaredPath({}, {
      existsSyncFn: (() => false) as typeof import('node:fs').existsSync,
      platform: 'linux',
    })).toBe('cloudflared')
  })

  it('waitForTunnelUrl resolves with the trycloudflare URL from stderr', async () => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
    }) as unknown as SidecarChild
    const promise = waitForTunnelUrl(child, { timeoutMs: 1000 })
    child.stderr.emit('data', 'INF |  https://random-words-42.trycloudflare.com  |\n')
    await expect(promise).resolves.toBe('https://random-words-42.trycloudflare.com')
  })

  it('waitForTunnelUrl rejects when cloudflared exits before printing a URL', async () => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
    }) as unknown as SidecarChild
    const promise = waitForTunnelUrl(child, { timeoutMs: 1000 })
    child.emit('exit', 1)
    await expect(promise).rejects.toThrow(/exited before printing/i)
  })

  it('waitForTunnelUrl rejects on timeout', async () => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
    }) as unknown as SidecarChild
    await expect(waitForTunnelUrl(child, { timeoutMs: 20 })).rejects.toThrow(/Timed out/i)
  })
})
